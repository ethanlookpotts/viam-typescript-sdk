import type { PromiseClient } from '@connectrpc/connect';
import { EventDispatcher, MachineConnectionEvent } from '../../events';
import { StreamService } from '../../gen/stream/v1/stream_connect';
import {
  AddStreamRequest,
  RemoveStreamRequest,
} from '../../gen/stream/v1/stream_pb';
import type { RobotClient } from '../../robot';
import type { Options } from '../../types';
import type { Stream } from './stream';

/*
 * Returns a valid SDP video/audio track name as defined in RFC 4566 (https://www.rfc-editor.org/rfc/rfc4566)
 * where track names should not include colons.
 */
const getValidSDPTrackName = (name: string) => {
  return name.replaceAll(':', '+');
};

/**
 * A gRPC-web client for a Stream.
 *
 * @group Clients
 */
export class StreamClient extends EventDispatcher implements Stream {
  private client: PromiseClient<typeof StreamService>;
  private readonly options: Options;
  private streams: Set<string>;

  constructor(client: RobotClient, options: Options = {}) {
    super();
    this.client = client.createServiceClient(StreamService);
    this.options = options;
    this.streams = new Set();

    /**
     * Currently this is emitting events for every track that we recieve. In the
     * future we'll want to partition here and have individual events for each
     * stream.
     */
    client.on('track', (args) => {
      this.emit('track', args);
    });

    client.on(MachineConnectionEvent.CONNECTED, () => {
      for (const name of this.streams.values()) {
        void this.add(name);
      }
    });
  }

  async add(name: string) {
    const request = new AddStreamRequest({
      name: getValidSDPTrackName(name),
    });
    this.options.requestLogger?.(request);
    try {
      await this.client.addStream(request);
      this.streams.add(name);
    } catch {
      // Try again with just the resource name
      request.name = name;
      this.options.requestLogger?.(request);
      await this.client.addStream(request);
      this.streams.add(name);
    }
  }

  async remove(name: string) {
    const request = new RemoveStreamRequest({
      name: getValidSDPTrackName(name),
    });
    this.options.requestLogger?.(request);
    try {
      await this.client.removeStream(request);
      this.streams.delete(name);
    } catch {
      // Try again with just the resource name
      request.name = name;
      this.options.requestLogger?.(request);
      await this.client.removeStream(request);
      this.streams.delete(name);
    }
  }

  private STREAM_TIMEOUT = 5000;

  /**
   * Get a stream by name from a StreamClient. Will time out if stream is not
   * received within 5 seconds.
   *
   * @param name - The name of a camera component.
   */
  getStream = async (name: string): Promise<MediaStream> => {
    const streamPromise = new Promise<MediaStream>((resolve, reject) => {
      const handleTrack = (event: RTCTrackEvent) => {
        const [stream] = event.streams;

        if (!stream) {
          this.off('track', handleTrack as (args: unknown) => void);
          reject(new Error('Recieved track event with no streams'));
        } else if (stream.id === name) {
          this.off('track', handleTrack as (args: unknown) => void);
          resolve(stream);
        }
      };

      this.on('track', handleTrack as (args: unknown) => void);

      setTimeout(() => {
        this.off('track', handleTrack as (args: unknown) => void);
        reject(
          new Error(`Did not receive a stream after ${this.STREAM_TIMEOUT} ms`)
        );
      }, this.STREAM_TIMEOUT);
    });

    await this.add(name);

    return streamPromise;
  };
}
