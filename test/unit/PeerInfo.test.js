const { PeerInfo } = require('../../src/connection/PeerInfo')

describe('PeerInfo', () => {
    let nodeInfo
    let storageInfo
    let trackerInfo
    let unknownInfo

    beforeEach(() => {
        nodeInfo = PeerInfo.newNode('node')
        storageInfo = PeerInfo.newStorage('storage')
        trackerInfo = PeerInfo.newTracker('tracker')
        unknownInfo = PeerInfo.newUnknown('unknown')
    })

    it('isNode', () => {
        expect(nodeInfo.isNode()).toEqual(true)
        expect(storageInfo.isNode()).toEqual(true)
        expect(trackerInfo.isNode()).toEqual(false)
        expect(unknownInfo.isNode()).toEqual(false)
    })

    it('isStorage', () => {
        expect(nodeInfo.isStorage()).toEqual(false)
        expect(storageInfo.isStorage()).toEqual(true)
        expect(trackerInfo.isStorage()).toEqual(false)
        expect(unknownInfo.isStorage()).toEqual(false)
    })

    it('isTracker', () => {
        expect(nodeInfo.isTracker()).toEqual(false)
        expect(storageInfo.isTracker()).toEqual(false)
        expect(trackerInfo.isTracker()).toEqual(true)
        expect(unknownInfo.isTracker()).toEqual(false)
    })

    it('toString', () => {
        expect(nodeInfo.toString()).toEqual('node (node)')
        expect(storageInfo.toString()).toEqual('storage (storage)')
        expect(trackerInfo.toString()).toEqual('tracker (tracker)')
        expect(unknownInfo.toString()).toEqual('unknown (unknown)')
    })

    it('PeerInfo constructor throws if invalid peerType', () => {
        expect(() => new PeerInfo('peerId', 'invalidPeerType')).toThrow()
    })

    it('fromObject', () => {
        const peerInfo = PeerInfo.fromObject({
            peerId: 'peerId',
            peerType: 'tracker'
        })
        expect(peerInfo.peerId).toEqual('peerId')
        expect(peerInfo.isTracker()).toEqual(true)
    })
})