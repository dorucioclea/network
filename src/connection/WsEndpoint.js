const { EventEmitter } = require('events')

const WebSocket = require('ws')
const uWS = require('uWebSockets.js')

const getLogger = require('../helpers/logger')
const MetricsContext = require('../helpers/MetricsContext')
const extraLogger = require('../helpers/logger')('streamr:ws-endpoint')

const { PeerBook } = require('./PeerBook')
const { PeerInfo } = require('./PeerInfo')

const HIGH_BACK_PRESSURE = 1024 * 1024 * 2
const LOW_BACK_PRESSURE = 1024 * 1024
const WS_BUFFER_SIZE = HIGH_BACK_PRESSURE + 1024 // add 1 MB safety margin

const events = Object.freeze({
    PEER_CONNECTED: 'streamr:peer:connect',
    PEER_DISCONNECTED: 'streamr:peer:disconnect',
    MESSAGE_RECEIVED: 'streamr:message-received',
    HIGH_BACK_PRESSURE: 'streamr:high-back-pressure',
    LOW_BACK_PRESSURE: 'streamr:low-back-pressure',
})

const disconnectionCodes = Object.freeze({
    GRACEFUL_SHUTDOWN: 1000,
    DUPLICATE_SOCKET: 1002,
    NO_SHARED_STREAMS: 1000,
    MISSING_REQUIRED_PARAMETER: 1002,
    DEAD_CONNECTION: 1002
})

const disconnectionReasons = Object.freeze({
    GRACEFUL_SHUTDOWN: 'streamr:node:graceful-shutdown',
    DUPLICATE_SOCKET: 'streamr:endpoint:duplicate-connection',
    NO_SHARED_STREAMS: 'streamr:node:no-shared-streams',
    MISSING_REQUIRED_PARAMETER: 'streamr:node:missing-required-parameter',
    DEAD_CONNECTION: 'streamr:endpoint:dead-connection'
})

const ab2str = (buf) => Buffer.from(buf).toString('utf8')

// TODO uWS will soon rename end -> close and end -> terminate
const closeWs = (ws, code, reason, logger) => {
    // only ws/ws lib has terminate method
    try {
        if (ws.terminate !== undefined) {
            ws.close(code, reason)
        } else {
            ws.end(code, reason)
        }
    } catch (e) {
        logger.error(`Failed to close ws, error: ${e}`)
    }
}

const getBufferedAmount = (ws) => {
    // only uws lib has getBufferedAmount method
    if (ws.getBufferedAmount !== undefined) {
        return ws.getBufferedAmount()
    }

    return ws.bufferedAmount
}

const terminateWs = (ws, logger) => {
    try {
        // only ws/ws lib has terminate method
        if (ws.terminate !== undefined) {
            ws.terminate()
        } else {
            ws.close()
        }
    } catch (e) {
        logger.error(`Failed to terminate ws, error: ${e}`)
    }
}

// asObject
function toHeaders(peerInfo) {
    return {
        'streamr-peer-id': peerInfo.peerId,
        'streamr-peer-type': peerInfo.peerType
    }
}

class WsEndpoint extends EventEmitter {
    constructor(host, port, wss, listenSocket, peerInfo, advertisedWsUrl, metricsContext = new MetricsContext(null), pingInterval = 5 * 1000) {
        super()

        if (!wss) {
            throw new Error('wss not given')
        }
        if (!(peerInfo instanceof PeerInfo)) {
            throw new Error('peerInfo not instance of PeerInfo')
        }
        if (advertisedWsUrl === undefined) {
            throw new Error('advertisedWsUrl not given')
        }

        this._serverHost = host
        this._serverPort = port
        this._listenSocket = listenSocket

        this.logger = getLogger(`streamr:connection:ws-endpoint:${peerInfo.peerId}`)

        this.wss = wss
        this.peerInfo = peerInfo
        this.advertisedWsUrl = advertisedWsUrl

        this.connections = new Map()
        this.pendingConnections = new Map()
        this.peerBook = new PeerBook()

        this.wss.ws('/ws', {
            compression: 0,
            maxPayloadLength: 1024 * 1024,
            maxBackpressure: WS_BUFFER_SIZE,
            idleTimeout: 0,
            upgrade: (res, req, context) => {
                res.writeStatus('101 Switching Protocols')
                    .writeHeader('streamr-peer-id', this.peerInfo.peerId)
                    .writeHeader('streamr-peer-type', this.peerInfo.peerType)

                /* This immediately calls open handler, you must not use res after this call */
                res.upgrade({
                    address: req.getQuery('address'),
                    peerId: req.getHeader('streamr-peer-id'),
                    peerType: req.getHeader('streamr-peer-type'),
                },
                /* Spell these correctly */
                req.getHeader('sec-websocket-key'),
                req.getHeader('sec-websocket-protocol'),
                req.getHeader('sec-websocket-extensions'),
                context)
            },
            open: (ws) => {
                this._onIncomingConnection(ws)
            },
            message: (ws, message, isBinary) => {
                const connection = this.connections.get(ws.address)

                if (connection) {
                    this.onReceive(ws.peerInfo, ws.address, ab2str(message))
                }
            },
            drain: (ws) => {
                this._evaluateBackPressure(ws)
            },
            close: (ws, code, message) => {
                const reason = ab2str(message)

                const connection = this.connections.get(ws.address)

                if (connection) {
                    // added 'close' event for test - duplicate-connections-are-closed.test.js
                    this.emit('close', ws, code, reason)
                    this._onClose(ws.address, this.peerBook.getPeerInfo(ws.address), code, reason)
                }
            },
            pong: (ws) => {
                const connection = this.connections.get(ws.address)

                if (connection) {
                    this.logger.debug(`<== received from ${ws.address} "pong" frame`)
                    connection.respondedPong = true
                    connection.rtt = Date.now() - connection.rttStart
                }
            }
        })

        this.logger.debug('listening on: %s', this.getAddress())
        this._pingInterval = setInterval(() => this._pingConnections(), pingInterval)

        this.metrics = metricsContext.create('WsEndpoint')
            .addRecordedMetric('inSpeed')
            .addRecordedMetric('outSpeed')
            .addRecordedMetric('msgSpeed')
            .addRecordedMetric('msgInSpeed')
            .addRecordedMetric('msgOutSpeed')
            .addRecordedMetric('open')
            .addRecordedMetric('open:duplicateSocket')
            .addRecordedMetric('open:failedException')
            .addRecordedMetric('open:headersNotReceived')
            .addRecordedMetric('open:missingParameter')
            .addRecordedMetric('open:ownAddress')
            .addRecordedMetric('close')
            .addRecordedMetric('sendFailed')
            .addRecordedMetric('webSocketError')
            .addQueriedMetric('connections', () => this.connections.size)
            .addQueriedMetric('pendingConnections', () => this.pendingConnections.size)
            .addQueriedMetric('totalWebSocketBuffer', () => {
                return [...this.connections.values()]
                    .reduce((totalBufferSizeSum, ws) => totalBufferSizeSum + getBufferedAmount(ws), 0)
            })
    }

    _pingConnections() {
        const addresses = [...this.connections.keys()]
        addresses.forEach((address) => {
            const ws = this.connections.get(address)

            try {
                // didn't get "pong" in pingInterval
                if (ws.respondedPong !== undefined && !ws.respondedPong) {
                    throw new Error('ws is not active')
                }

                // eslint-disable-next-line no-param-reassign
                ws.respondedPong = false
                ws.rttStart = Date.now()
                ws.ping()
                this.logger.debug(`pinging ${address}, current rtt ${ws.rtt}`)
            } catch (e) {
                this.logger.error(`Failed to ping connection: ${address}, error ${e}, terminating connection`)
                terminateWs(ws, this.logger)
                this._onClose(
                    address, this.peerBook.getPeerInfo(address),
                    disconnectionCodes.DEAD_CONNECTION, disconnectionReasons.DEAD_CONNECTION
                )
            }
        })
    }

    send(recipientId, message) {
        const recipientAddress = this.resolveAddress(recipientId)
        return new Promise((resolve, reject) => {
            if (!this.isConnected(recipientAddress)) {
                this.metrics.record('sendFailed', 1)
                this.logger.debug('cannot send to %s because not connected', recipientAddress)
                reject(new Error(`cannot send to ${recipientAddress} because not connected`))
            } else {
                const ws = this.connections.get(recipientAddress)
                this._socketSend(ws, message, recipientId, recipientAddress, resolve, reject)
            }
        })
    }

    _socketSend(ws, message, recipientId, recipientAddress, successCallback, errorCallback) {
        const onSuccess = (address, peerId, msg) => {
            this.logger.debug('sent to %s message "%s"', address, msg)
            this.metrics.record('outSpeed', msg.length)
            this.metrics.record('msgSpeed', 1)
            this.metrics.record('msgOutSpeed', 1)
            successCallback(peerId)
        }

        try {
            if (ws.constructor.name === 'uWS.WebSocket') {
                ws.send(message)
                onSuccess(recipientAddress, recipientId, message)
            } else {
                ws.send(message, (err) => {
                    if (err) {
                        this.metrics.record('sendFailed', 1)
                        errorCallback(err)
                    } else {
                        onSuccess(recipientAddress, recipientId, message, successCallback)
                    }
                })
            }
            this._evaluateBackPressure(ws)
        } catch (e) {
            this.metrics.record('sendFailed', 1)
            this.logger.error('sending to %s failed because of %s, readyState is', recipientAddress, e, ws.readyState)
            terminateWs(ws, this.logger)
        }
    }

    _evaluateBackPressure(ws) {
        const bufferedAmount = getBufferedAmount(ws)
        if (!ws.highBackPressure && bufferedAmount > HIGH_BACK_PRESSURE) {
            this.logger.debug('Back pressure HIGH for %s at %d', this.id, bufferedAmount)
            this.emit(events.HIGH_BACK_PRESSURE, ws.peerInfo)
            // eslint-disable-next-line no-param-reassign
            ws.highBackPressure = true
        } else if (ws.highBackPressure && bufferedAmount < LOW_BACK_PRESSURE) {
            this.logger.debug('Back pressure LOW for %s at %d', this.id, bufferedAmount)
            this.emit(events.LOW_BACK_PRESSURE, ws.peerInfo)
            // eslint-disable-next-line no-param-reassign
            ws.highBackPressure = false
        }
    }

    onReceive(peerInfo, address, message) {
        this.logger.debug('<=== received from %s [%s] message "%s"', peerInfo, address, message)
        this.emit(events.MESSAGE_RECEIVED, peerInfo, message)
    }

    close(recipientId, reason = disconnectionReasons.GRACEFUL_SHUTDOWN) {
        const recipientAddress = this.resolveAddress(recipientId)

        this.metrics.record('close', 1)
        if (!this.isConnected(recipientAddress)) {
            this.logger.debug('cannot close connection to %s because not connected', recipientAddress)
        } else {
            const ws = this.connections.get(recipientAddress)
            try {
                this.logger.debug('closing connection to %s, reason %s', recipientAddress, reason)
                closeWs(ws, disconnectionCodes.GRACEFUL_SHUTDOWN, reason, this.logger)
            } catch (e) {
                this.logger.error('closing connection to %s failed because of %s', recipientAddress, e)
            }
        }
    }

    connect(peerAddress) {
        if (this.isConnected(peerAddress)) {
            const ws = this.connections.get(peerAddress)

            if (ws.readyState === ws.OPEN) {
                this.logger.debug('already connected to %s', peerAddress)
                return Promise.resolve(this.peerBook.getPeerId(peerAddress))
            }

            this.logger.debug(`already connected but readyState is ${ws.readyState}, closing connection`)
            this.close(this.peerBook.getPeerId(peerAddress))
        }

        if (peerAddress === this.getAddress()) {
            this.metrics.record('open:ownAddress', 1)
            this.logger.debug('not allowed to connect to own address %s', peerAddress)
            return Promise.reject(new Error('trying to connect to own address'))
        }

        if (this.pendingConnections.has(peerAddress)) {
            this.logger.debug('pending connection to %s', peerAddress)
            return this.pendingConnections.get(peerAddress)
        }

        this.logger.debug('===> connecting to %s', peerAddress)

        const p = new Promise((resolve, reject) => {
            try {
                let serverPeerInfo
                const ws = new WebSocket(
                    `${peerAddress}/ws?address=${this.getAddress()}`,
                    {
                        headers: toHeaders(this.peerInfo)
                    }
                )

                ws.on('upgrade', (res) => {
                    const peerId = res.headers['streamr-peer-id']
                    const peerType = res.headers['streamr-peer-type']

                    if (peerId && peerType) {
                        serverPeerInfo = new PeerInfo(peerId, peerType)
                    }
                })

                ws.once('open', () => {
                    if (!serverPeerInfo) {
                        terminateWs(ws, this.logger)
                        this.metrics.record('open:headersNotReceived', 1)
                        reject(new Error('dropping outgoing connection because connection headers never received'))
                    } else {
                        this._addListeners(ws, peerAddress, serverPeerInfo)
                        const result = this._onNewConnection(ws, peerAddress, serverPeerInfo, true)
                        if (result) {
                            resolve(this.peerBook.getPeerId(peerAddress))
                        } else {
                            reject(new Error(`duplicate connection to ${peerAddress} is dropped`))
                        }
                    }
                })

                ws.on('error', (err) => {
                    this.metrics.record('webSocketError', 1)
                    this.logger.debug('failed to connect to %s, error: %o', peerAddress, err)
                    terminateWs(ws, this.logger)
                    reject(err)
                })
            } catch (err) {
                this.metrics.record('open:failedException', 1)
                this.logger.debug('failed to connect to %s, error: %o', peerAddress, err)
                reject(err)
            }
        }).finally(() => {
            this.pendingConnections.delete(peerAddress)
        })

        this.pendingConnections.set(peerAddress, p)
        return p
    }

    stop() {
        clearInterval(this._pingInterval)

        return new Promise((resolve, reject) => {
            try {
                this.connections.forEach((ws) => {
                    closeWs(ws, disconnectionCodes.GRACEFUL_SHUTDOWN, disconnectionReasons.GRACEFUL_SHUTDOWN, this.logger)
                })

                if (this._listenSocket) {
                    this.logger.debug('shutting down uWS server')
                    uWS.us_listen_socket_close(this._listenSocket)
                    this._listenSocket = null
                }

                setTimeout(() => resolve(), 100)
            } catch (e) {
                this.logger.error(e)
                reject(new Error(`Failed to stop websocket server, because of ${e}`))
            }
        })
    }

    isConnected(address) {
        return this.connections.has(address)
    }

    getRtts() {
        const connections = [...this.connections.keys()]
        const rtts = {}
        connections.forEach((address) => {
            const { rtt } = this.connections.get(address)
            const nodeId = this.peerBook.getPeerId(address)
            if (rtt !== undefined && rtt !== null) {
                rtts[nodeId] = rtt
            }
        })
        return rtts
    }

    getAddress() {
        if (this.advertisedWsUrl) {
            return this.advertisedWsUrl
        }

        return `ws://${this._serverHost}:${this._serverPort}`
    }

    getPeers() {
        return this.connections
    }

    resolveAddress(peerId) {
        return this.peerBook.getAddress(peerId)
    }

    _onIncomingConnection(ws) {
        const { address, peerId, peerType } = ws

        try {
            if (!address) {
                throw new Error('address not given')
            }
            if (!peerId) {
                throw new Error('peerId not given')
            }
            if (!peerType) {
                throw new Error('peerType not given')
            }

            const clientPeerInfo = new PeerInfo(peerId, peerType)
            if (this.isConnected(address)) {
                this.metrics.record('open:duplicateSocket', 1)
                ws.close(disconnectionCodes.DUPLICATE_SOCKET, disconnectionReasons.DUPLICATE_SOCKET)
                return
            }

            this.logger.debug('<=== %s connecting to me', address)
            // added 'connection' event for test - duplicate-connections-are-closed.test.js
            this.emit('connection', ws)
            this._onNewConnection(ws, address, clientPeerInfo, false)
        } catch (e) {
            this.logger.debug('dropped incoming connection because of %s', e)
            this.metrics.record('open:missingParameter', 1)
            closeWs(ws, disconnectionCodes.MISSING_REQUIRED_PARAMETER, e.toString(), this.logger)
        }
    }

    _onClose(address, peerInfo, code = 0, reason = '') {
        if (reason === disconnectionReasons.DUPLICATE_SOCKET) {
            this.metrics.record('open:duplicateSocket', 1)
            this.logger.debug('socket %s dropped from other side because existing connection already exists')
            return
        }

        this.metrics.record('close', 1)
        this.logger.debug('socket to %s closed (code %d, reason %s)', address, code, reason)
        this.connections.delete(address)
        this.peerBook.getPeerId(address)
        this.logger.debug('removed %s [%s] from connection list', peerInfo, address)
        this.emit(events.PEER_DISCONNECTED, peerInfo, reason)
    }

    _onNewConnection(ws, address, peerInfo, out) {
        // Handle scenario where two peers have opened a socket to each other at the same time.
        // Second condition is a tiebreaker to avoid both peers of simultaneously disconnecting their socket,
        // thereby leaving no connection behind.
        if (this.isConnected(address) && this.getAddress().localeCompare(address) === 1) {
            this.metrics.record('open:duplicateSocket', 1)
            this.logger.debug('dropped new connection with %s because an existing connection already exists', address)
            closeWs(ws, disconnectionCodes.DUPLICATE_SOCKET, disconnectionReasons.DUPLICATE_SOCKET, this.logger)
            return false
        }

        // eslint-disable-next-line no-param-reassign
        ws.peerInfo = peerInfo
        // eslint-disable-next-line no-param-reassign
        ws.address = address
        this.peerBook.add(address, peerInfo)
        this.connections.set(address, ws)
        this.metrics.record('open', 1)
        this.logger.debug('added %s [%s] to connection list', peerInfo, address)
        this.logger.debug('%s connected to %s', out ? '===>' : '<===', address)
        this.emit(events.PEER_CONNECTED, peerInfo)

        return true
    }

    _addListeners(ws, address, peerInfo) {
        ws.on('message', (message) => {
            // TODO check message.type [utf8|binary]
            this.metrics.record('inSpeed', message.length)
            this.metrics.record('msgSpeed', 1)
            this.metrics.record('msgInSpeed', 1)

            // toString() needed for SSL connections as message will be Buffer instead of String
            setImmediate(() => this.onReceive(peerInfo, address, message.toString()))
        })

        ws.on('pong', () => {
            this.logger.debug(`=> got pong event ws ${address}`)
            // eslint-disable-next-line no-param-reassign
            ws.respondedPong = true
            // eslint-disable-next-line no-param-reassign
            ws.rtt = Date.now() - ws.rttStart
        })

        ws.once('close', (code, reason) => {
            if (reason === disconnectionReasons.DUPLICATE_SOCKET) {
                this.metrics.record('open:duplicateSocket', 1)
                this.logger.debug('socket %s dropped from other side because existing connection already exists')
                return
            }

            this._onClose(address, this.peerBook.getPeerInfo(address), code, reason)
        })
    }
}

async function startWebSocketServer(host, port, privateKeyFileName = undefined, certFileName = undefined) {
    return new Promise((resolve, reject) => {
        let server
        if (privateKeyFileName && certFileName) {
            extraLogger.debug(`starting SSL uWS server (host: ${host}, port: ${port}, using ${privateKeyFileName}, ${certFileName}`)
            server = uWS.SSLApp({
                key_file_name: privateKeyFileName,
                cert_file_name: certFileName,
            })
        } else {
            extraLogger.debug(`starting non-SSL uWS (host: ${host}, port: ${port}`)
            server = uWS.App()
        }

        const cb = (listenSocket) => {
            if (listenSocket) {
                resolve([server, listenSocket])
            } else {
                reject(new Error(`Failed to start websocket server, host ${host}, port ${port}`))
            }
        }

        if (host) {
            server.listen(host, port, cb)
        } else {
            server.listen(port, cb)
        }
    })
}

async function startEndpoint(host, port, peerInfo, advertisedWsUrl, metricsContext, pingInterval, privateKeyFileName = undefined, certFileName = undefined) {
    return startWebSocketServer(host, port, privateKeyFileName, certFileName).then(([wss, listenSocket]) => {
        return new WsEndpoint(host, port, wss, listenSocket, peerInfo, advertisedWsUrl, metricsContext, pingInterval)
    })
}

module.exports = {
    WsEndpoint,
    events,
    startWebSocketServer,
    startEndpoint,
    disconnectionCodes,
    disconnectionReasons
}
