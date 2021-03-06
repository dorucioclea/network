const { waitForEvent, waitForCondition } = require('streamr-test-utils')

const { startNetworkNode, startTracker } = require('../../src/composition')
const Node = require('../../src/logic/Node')
const TrackerServer = require('../../src/protocol/TrackerServer')

describe('check tracker, nodes and statuses from nodes', () => {
    let tracker
    let subscriberOne
    let subscriberTwo

    beforeEach(async () => {
        tracker = await startTracker({
            host: '127.0.0.1',
            port: 32400,
            id: 'tracker'
        })
        subscriberOne = await startNetworkNode({
            host: '127.0.0.1',
            port: 33371,
            id: 'subscriberOne',
            trackers: [tracker.getAddress()]
        })
        subscriberTwo = await startNetworkNode({
            host: '127.0.0.1',
            port: 33372,
            id: 'subscriberTwo',
            trackers: [tracker.getAddress()]
        })

        subscriberOne.subscribe('stream-1', 0)
        subscriberOne.subscribe('stream-2', 2)

        subscriberTwo.subscribe('stream-1', 0)
        subscriberTwo.subscribe('stream-2', 2)
    })

    afterEach(async () => {
        await subscriberOne.stop()
        await subscriberTwo.stop()
        await tracker.stop()
    })

    it('should be able to start two nodes, receive statuses, subscribe to streams', async () => {
        subscriberOne.start()
        await waitForEvent(tracker.protocols.trackerServer, TrackerServer.events.NODE_STATUS_RECEIVED)
        expect(tracker.getTopology()).toEqual({
            'stream-1::0': {
                subscriberOne: [],
            },
            'stream-2::2': {
                subscriberOne: []
            }
        })

        subscriberTwo.start()
        await waitForEvent(tracker.protocols.trackerServer, TrackerServer.events.NODE_STATUS_RECEIVED)
        expect(tracker.getTopology()).toEqual({
            'stream-1::0': {
                subscriberOne: ['subscriberTwo'],
                subscriberTwo: ['subscriberOne']
            },
            'stream-2::2': {
                subscriberOne: ['subscriberTwo'],
                subscriberTwo: ['subscriberOne']
            }
        })
    })

    it('tracker should update correctly overlays on subscribe/unsubscribe', async () => {
        subscriberOne.start()
        subscriberTwo.start()

        await Promise.all([
            waitForEvent(subscriberOne, Node.events.NODE_SUBSCRIBED),
            waitForEvent(subscriberTwo, Node.events.NODE_SUBSCRIBED)
        ])
        await waitForEvent(tracker.protocols.trackerServer, TrackerServer.events.NODE_STATUS_RECEIVED)

        subscriberOne.unsubscribe('stream-2', 2)
        await waitForEvent(subscriberTwo, Node.events.NODE_UNSUBSCRIBED)
        await waitForEvent(tracker.protocols.trackerServer, TrackerServer.events.NODE_STATUS_RECEIVED)
        expect(tracker.getTopology()).toEqual({
            'stream-1::0': {
                subscriberOne: ['subscriberTwo'],
                subscriberTwo: ['subscriberOne'],
            },
            'stream-2::2': {
                subscriberTwo: []
            }
        })

        subscriberOne.unsubscribe('stream-1', 0)
        await waitForEvent(subscriberTwo, Node.events.NODE_UNSUBSCRIBED)
        await waitForEvent(tracker.protocols.trackerServer, TrackerServer.events.NODE_STATUS_RECEIVED)
        expect(tracker.getTopology()).toEqual({
            'stream-1::0': {
                subscriberTwo: [],
            },
            'stream-2::2': {
                subscriberTwo: []
            }
        })

        subscriberTwo.unsubscribe('stream-1', 0)
        await waitForCondition(() => tracker.getTopology()['stream-1::0'] == null)
        expect(tracker.getTopology()).toEqual({
            'stream-2::2': {
                subscriberTwo: []
            }
        })

        subscriberTwo.unsubscribe('stream-2', 2)
        await waitForEvent(tracker.protocols.trackerServer, TrackerServer.events.NODE_STATUS_RECEIVED)
        expect(tracker.getTopology()).toEqual({})
    }, 10 * 1000)
})
