/*
 * Copyright 2019 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import * as http2 from 'http2';
import { ChannelCredentials } from './channel-credentials';
import { Metadata } from './metadata';
import { ChannelOptions } from './channel-options';
import { PeerCertificate, checkServerIdentity, TLSSocket, CipherNameAndProtocol } from 'tls';
import { ConnectivityState } from './connectivity-state';
import { BackoffTimeout, BackoffOptions } from './backoff-timeout';
import { getDefaultAuthority } from './resolver';
import * as logging from './logging';
import { LogVerbosity, Status } from './constants';
import { getProxiedConnection, ProxyConnectionResult } from './http_proxy';
import * as net from 'net';
import { GrpcUri, parseUri, splitHostPort, uriToString } from './uri-parser';
import { ConnectionOptions } from 'tls';
import {
  stringToSubchannelAddress,
  SubchannelAddress,
  subchannelAddressToString,
} from './subchannel-address';
import { SubchannelRef, ChannelzTrace, ChannelzChildrenTracker, SubchannelInfo, registerChannelzSubchannel, ChannelzCallTracker, SocketInfo, SocketRef, unregisterChannelzRef, registerChannelzSocket, TlsInfo } from './channelz';
import { ConnectivityStateListener } from './subchannel-interface';
import { Http2SubchannelCall } from './subchannel-call';
import { getNextCallNumber } from './call-number';
import { SubchannelCall } from './subchannel-call';
import { InterceptingListener, StatusObject } from './call-interface';

const clientVersion = require('../../package.json').version;

const TRACER_NAME = 'subchannel';
const FLOW_CONTROL_TRACER_NAME = 'subchannel_flowctrl';

/* setInterval and setTimeout only accept signed 32 bit integers. JS doesn't
 * have a constant for the max signed 32 bit integer, so this is a simple way
 * to calculate it */
const KEEPALIVE_MAX_TIME_MS = ~(1 << 31);
const KEEPALIVE_TIMEOUT_MS = 20000;

export interface SubchannelCallStatsTracker {
  addMessageSent(): void;
  addMessageReceived(): void;
  onCallEnd(status: StatusObject): void;
  onStreamEnd(success: boolean): void;
}

const {
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_CONTENT_TYPE,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_TE,
  HTTP2_HEADER_USER_AGENT,
} = http2.constants;

const tooManyPingsData: Buffer = Buffer.from('too_many_pings', 'ascii');

export class Subchannel {
  /**
   * The subchannel's current connectivity state. Invariant: `session` === `null`
   * if and only if `connectivityState` is IDLE or TRANSIENT_FAILURE.
   */
  private connectivityState: ConnectivityState = ConnectivityState.IDLE;
  /**
   * The underlying http2 session used to make requests.
   */
  private session: http2.ClientHttp2Session | null = null;
  /**
   * Indicates that the subchannel should transition from TRANSIENT_FAILURE to
   * CONNECTING instead of IDLE when the backoff timeout ends.
   */
  private continueConnecting = false;
  /**
   * A list of listener functions that will be called whenever the connectivity
   * state changes. Will be modified by `addConnectivityStateListener` and
   * `removeConnectivityStateListener`
   */
  private stateListeners: ConnectivityStateListener[] = [];

  /**
   * A list of listener functions that will be called when the underlying
   * socket disconnects. Used for ending active calls with an UNAVAILABLE
   * status.
   */
  private disconnectListeners: Set<() => void> = new Set();

  private backoffTimeout: BackoffTimeout;

  /**
   * The complete user agent string constructed using channel args.
   */
  private userAgent: string;

  /**
   * The amount of time in between sending pings
   */
  private keepaliveTimeMs: number = KEEPALIVE_MAX_TIME_MS;
  /**
   * The amount of time to wait for an acknowledgement after sending a ping
   */
  private keepaliveTimeoutMs: number = KEEPALIVE_TIMEOUT_MS;
  /**
   * Timer reference for timeout that indicates when to send the next ping
   */
  private keepaliveIntervalId: NodeJS.Timer;
  /**
   * Timer reference tracking when the most recent ping will be considered lost
   */
  private keepaliveTimeoutId: NodeJS.Timer;
  /**
   * Indicates whether keepalive pings should be sent without any active calls
   */
  private keepaliveWithoutCalls = false;

  /**
   * Tracks calls with references to this subchannel
   */
  private callRefcount = 0;
  /**
   * Tracks channels and subchannel pools with references to this subchannel
   */
  private refcount = 0;

  /**
   * A string representation of the subchannel address, for logging/tracing
   */
  private subchannelAddressString: string;

  // Channelz info
  private readonly channelzEnabled: boolean = true;
  private channelzRef: SubchannelRef;
  private channelzTrace: ChannelzTrace;
  private callTracker = new ChannelzCallTracker();
  private childrenTracker = new ChannelzChildrenTracker();

  // Channelz socket info
  private channelzSocketRef: SocketRef | null = null;
  /**
   * Name of the remote server, if it is not the same as the subchannel
   * address, i.e. if connecting through an HTTP CONNECT proxy.
   */
  private remoteName: string | null = null;
  private streamTracker = new ChannelzCallTracker();
  private keepalivesSent = 0;
  private messagesSent = 0;
  private messagesReceived = 0;
  private lastMessageSentTimestamp: Date | null = null;
  private lastMessageReceivedTimestamp: Date | null = null;

  /**
   * A class representing a connection to a single backend.
   * @param channelTarget The target string for the channel as a whole
   * @param subchannelAddress The address for the backend that this subchannel
   *     will connect to
   * @param options The channel options, plus any specific subchannel options
   *     for this subchannel
   * @param credentials The channel credentials used to establish this
   *     connection
   */
  constructor(
    private channelTarget: GrpcUri,
    private subchannelAddress: SubchannelAddress,
    private options: ChannelOptions,
    private credentials: ChannelCredentials
  ) {
    // Build user-agent string.
    this.userAgent = [
      options['grpc.primary_user_agent'],
      `grpc-node-js/${clientVersion}`,
      options['grpc.secondary_user_agent'],
    ]
      .filter((e) => e)
      .join(' '); // remove falsey values first

    if ('grpc.keepalive_time_ms' in options) {
      this.keepaliveTimeMs = options['grpc.keepalive_time_ms']!;
    }
    if ('grpc.keepalive_timeout_ms' in options) {
      this.keepaliveTimeoutMs = options['grpc.keepalive_timeout_ms']!;
    }
    if ('grpc.keepalive_permit_without_calls' in options) {
      this.keepaliveWithoutCalls =
        options['grpc.keepalive_permit_without_calls'] === 1;
    } else {
      this.keepaliveWithoutCalls = false;
    }
    this.keepaliveIntervalId = setTimeout(() => {}, 0);
    clearTimeout(this.keepaliveIntervalId);
    this.keepaliveTimeoutId = setTimeout(() => {}, 0);
    clearTimeout(this.keepaliveTimeoutId);
    const backoffOptions: BackoffOptions = {
      initialDelay: options['grpc.initial_reconnect_backoff_ms'],
      maxDelay: options['grpc.max_reconnect_backoff_ms'],
    };
    this.backoffTimeout = new BackoffTimeout(() => {
      this.handleBackoffTimer();
    }, backoffOptions);
    this.subchannelAddressString = subchannelAddressToString(subchannelAddress);

    if (options['grpc.enable_channelz'] === 0) {
      this.channelzEnabled = false;
    }
    this.channelzTrace = new ChannelzTrace();
    this.channelzRef = registerChannelzSubchannel(this.subchannelAddressString, () => this.getChannelzInfo(), this.channelzEnabled);
    if (this.channelzEnabled) {
      this.channelzTrace.addTrace('CT_INFO', 'Subchannel created');
    }
    this.trace('Subchannel constructed with options ' + JSON.stringify(options, undefined, 2));
  }

  private getChannelzInfo(): SubchannelInfo {
    return {
      state: this.connectivityState,
      trace: this.channelzTrace,
      callTracker: this.callTracker,
      children: this.childrenTracker.getChildLists(),
      target: this.subchannelAddressString
    };
  }

  private getChannelzSocketInfo(): SocketInfo | null {
    if (this.session === null) {
      return null;
    }
    const sessionSocket = this.session.socket;
    const remoteAddress = sessionSocket.remoteAddress ? stringToSubchannelAddress(sessionSocket.remoteAddress, sessionSocket.remotePort) : null;
    const localAddress = sessionSocket.localAddress ? stringToSubchannelAddress(sessionSocket.localAddress, sessionSocket.localPort) : null;
    let tlsInfo: TlsInfo | null;
    if (this.session.encrypted) {
      const tlsSocket: TLSSocket = sessionSocket as TLSSocket;
      const cipherInfo: CipherNameAndProtocol & {standardName?: string} = tlsSocket.getCipher();
      const certificate = tlsSocket.getCertificate();
      const peerCertificate = tlsSocket.getPeerCertificate();
      tlsInfo = {
        cipherSuiteStandardName: cipherInfo.standardName ?? null,
        cipherSuiteOtherName: cipherInfo.standardName ? null : cipherInfo.name,
        localCertificate: (certificate && 'raw' in certificate) ? certificate.raw : null,
        remoteCertificate: (peerCertificate && 'raw' in peerCertificate) ? peerCertificate.raw : null
      };
    } else {
      tlsInfo = null;
    }
    const socketInfo: SocketInfo = {
      remoteAddress: remoteAddress,
      localAddress: localAddress,
      security: tlsInfo,
      remoteName: this.remoteName,
      streamsStarted: this.streamTracker.callsStarted,
      streamsSucceeded: this.streamTracker.callsSucceeded,
      streamsFailed: this.streamTracker.callsFailed,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      keepAlivesSent: this.keepalivesSent,
      lastLocalStreamCreatedTimestamp: this.streamTracker.lastCallStartedTimestamp,
      lastRemoteStreamCreatedTimestamp: null,
      lastMessageSentTimestamp: this.lastMessageSentTimestamp,
      lastMessageReceivedTimestamp: this.lastMessageReceivedTimestamp,
      localFlowControlWindow: this.session.state.localWindowSize ?? null,
      remoteFlowControlWindow: this.session.state.remoteWindowSize ?? null
    };
    return socketInfo;
  }

  private resetChannelzSocketInfo() {
    if (!this.channelzEnabled) {
      return;
    }
    if (this.channelzSocketRef) {
      unregisterChannelzRef(this.channelzSocketRef);
      this.childrenTracker.unrefChild(this.channelzSocketRef);
      this.channelzSocketRef = null;
    }
    this.remoteName = null;
    this.streamTracker = new ChannelzCallTracker();
    this.keepalivesSent = 0;
    this.messagesSent = 0;
    this.messagesReceived = 0;
    this.lastMessageSentTimestamp = null;
    this.lastMessageReceivedTimestamp = null;
  }

  private trace(text: string): void {
    logging.trace(LogVerbosity.DEBUG, TRACER_NAME, '(' + this.channelzRef.id + ') ' + this.subchannelAddressString + ' ' + text);
  }

  private refTrace(text: string): void {
    logging.trace(LogVerbosity.DEBUG, 'subchannel_refcount', '(' + this.channelzRef.id + ') ' + this.subchannelAddressString + ' ' + text);
  }

  private flowControlTrace(text: string): void {
    logging.trace(LogVerbosity.DEBUG, FLOW_CONTROL_TRACER_NAME, '(' + this.channelzRef.id + ') ' + this.subchannelAddressString + ' ' + text);
  }

  private internalsTrace(text: string): void {
    logging.trace(LogVerbosity.DEBUG, 'subchannel_internals', '(' + this.channelzRef.id + ') ' + this.subchannelAddressString + ' ' + text);
  }

  private keepaliveTrace(text: string): void {
    logging.trace(LogVerbosity.DEBUG, 'keepalive', '(' + this.channelzRef.id + ') ' + this.subchannelAddressString + ' ' + text);
  }

  private handleBackoffTimer() {
    if (this.continueConnecting) {
      this.transitionToState(
        [ConnectivityState.TRANSIENT_FAILURE],
        ConnectivityState.CONNECTING
      );
    } else {
      this.transitionToState(
        [ConnectivityState.TRANSIENT_FAILURE],
        ConnectivityState.IDLE
      );
    }
  }

  /**
   * Start a backoff timer with the current nextBackoff timeout
   */
  private startBackoff() {
    this.backoffTimeout.runOnce();
  }

  private stopBackoff() {
    this.backoffTimeout.stop();
    this.backoffTimeout.reset();
  }

  private sendPing() {
    if (this.channelzEnabled) {
      this.keepalivesSent += 1;
    }
    this.keepaliveTrace('Sending ping with timeout ' + this.keepaliveTimeoutMs + 'ms');
    this.keepaliveTimeoutId = setTimeout(() => {
      this.keepaliveTrace('Ping timeout passed without response');
      this.handleDisconnect();
    }, this.keepaliveTimeoutMs);
    this.keepaliveTimeoutId.unref?.();
    try {
      this.session!.ping(
        (err: Error | null, duration: number, payload: Buffer) => {
          this.keepaliveTrace('Received ping response');
          clearTimeout(this.keepaliveTimeoutId);
        }
      );
    } catch (e) {
      /* If we fail to send a ping, the connection is no longer functional, so
       * we should discard it. */
      this.transitionToState(
        [ConnectivityState.READY],
        ConnectivityState.TRANSIENT_FAILURE
      );
    }
  }

  private startKeepalivePings() {
    this.keepaliveIntervalId = setInterval(() => {
      this.sendPing();
    }, this.keepaliveTimeMs);
    this.keepaliveIntervalId.unref?.();
    /* Don't send a ping immediately because whatever caused us to start
     * sending pings should also involve some network activity. */
  }

  /**
   * Stop keepalive pings when terminating a connection. This discards the
   * outstanding ping timeout, so it should not be called if the same
   * connection will still be used.
   */
  private stopKeepalivePings() {
    clearInterval(this.keepaliveIntervalId);
    clearTimeout(this.keepaliveTimeoutId);
  }

  private createSession(proxyConnectionResult: ProxyConnectionResult) {
    if (proxyConnectionResult.realTarget) {
      this.remoteName = uriToString(proxyConnectionResult.realTarget);
      this.trace('creating HTTP/2 session through proxy to ' + proxyConnectionResult.realTarget);
    } else {
      this.remoteName = null;
      this.trace('creating HTTP/2 session');
    }
    const targetAuthority = getDefaultAuthority(
      proxyConnectionResult.realTarget ?? this.channelTarget
    );
    let connectionOptions: http2.SecureClientSessionOptions =
      this.credentials._getConnectionOptions() || {};
    connectionOptions.maxSendHeaderBlockLength = Number.MAX_SAFE_INTEGER;
    if ('grpc-node.max_session_memory' in this.options) {
      connectionOptions.maxSessionMemory = this.options[
        'grpc-node.max_session_memory'
      ];
    } else {
      /* By default, set a very large max session memory limit, to effectively
       * disable enforcement of the limit. Some testing indicates that Node's
       * behavior degrades badly when this limit is reached, so we solve that
       * by disabling the check entirely. */
      connectionOptions.maxSessionMemory = Number.MAX_SAFE_INTEGER;
    }
    let addressScheme = 'http://';
    if ('secureContext' in connectionOptions) {
      addressScheme = 'https://';
      // If provided, the value of grpc.ssl_target_name_override should be used
      // to override the target hostname when checking server identity.
      // This option is used for testing only.
      if (this.options['grpc.ssl_target_name_override']) {
        const sslTargetNameOverride = this.options[
          'grpc.ssl_target_name_override'
        ]!;
        connectionOptions.checkServerIdentity = (
          host: string,
          cert: PeerCertificate
        ): Error | undefined => {
          return checkServerIdentity(sslTargetNameOverride, cert);
        };
        connectionOptions.servername = sslTargetNameOverride;
      } else {
        const authorityHostname =
          splitHostPort(targetAuthority)?.host ?? 'localhost';
        // We want to always set servername to support SNI
        connectionOptions.servername = authorityHostname;
      }
      if (proxyConnectionResult.socket) {
        /* This is part of the workaround for
         * https://github.com/nodejs/node/issues/32922. Without that bug,
         * proxyConnectionResult.socket would always be a plaintext socket and
         * this would say
         * connectionOptions.socket = proxyConnectionResult.socket; */
        connectionOptions.createConnection = (authority, option) => {
          return proxyConnectionResult.socket!;
        };
      }
    } else {
      /* In all but the most recent versions of Node, http2.connect does not use
       * the options when establishing plaintext connections, so we need to
       * establish that connection explicitly. */
      connectionOptions.createConnection = (authority, option) => {
        if (proxyConnectionResult.socket) {
          return proxyConnectionResult.socket;
        } else {
          /* net.NetConnectOpts is declared in a way that is more restrictive
           * than what net.connect will actually accept, so we use the type
           * assertion to work around that. */
          return net.connect(this.subchannelAddress);
        }
      };
    }

    connectionOptions = {
      ...connectionOptions,
      ...this.subchannelAddress,
    };

    /* http2.connect uses the options here:
     * https://github.com/nodejs/node/blob/70c32a6d190e2b5d7b9ff9d5b6a459d14e8b7d59/lib/internal/http2/core.js#L3028-L3036
     * The spread operator overides earlier values with later ones, so any port
     * or host values in the options will be used rather than any values extracted
     * from the first argument. In addition, the path overrides the host and port,
     * as documented for plaintext connections here:
     * https://nodejs.org/api/net.html#net_socket_connect_options_connectlistener
     * and for TLS connections here:
     * https://nodejs.org/api/tls.html#tls_tls_connect_options_callback. In
     * earlier versions of Node, http2.connect passes these options to
     * tls.connect but not net.connect, so in the insecure case we still need
     * to set the createConnection option above to create the connection
     * explicitly. We cannot do that in the TLS case because http2.connect
     * passes necessary additional options to tls.connect.
     * The first argument just needs to be parseable as a URL and the scheme
     * determines whether the connection will be established over TLS or not.
     */
    const session = http2.connect(
      addressScheme + targetAuthority,
      connectionOptions
    );
    this.session = session;
    this.channelzSocketRef = registerChannelzSocket(this.subchannelAddressString, () => this.getChannelzSocketInfo()!, this.channelzEnabled);
    if (this.channelzEnabled) {
      this.childrenTracker.refChild(this.channelzSocketRef);
    }
    session.unref();
    /* For all of these events, check if the session at the time of the event
     * is the same one currently attached to this subchannel, to ensure that
     * old events from previous connection attempts cannot cause invalid state
     * transitions. */
    session.once('connect', () => {
      if (this.session === session) {
        this.transitionToState(
          [ConnectivityState.CONNECTING],
          ConnectivityState.READY
        );
      }
    });
    session.once('close', () => {
      if (this.session === session) {
        this.trace('connection closed');
        this.transitionToState(
          [ConnectivityState.CONNECTING],
          ConnectivityState.TRANSIENT_FAILURE
        );
        /* Transitioning directly to IDLE here should be OK because we are not
         * doing any backoff, because a connection was established at some
         * point */
        this.transitionToState(
          [ConnectivityState.READY],
          ConnectivityState.IDLE
        );
      }
    });
    session.once(
      'goaway',
      (errorCode: number, lastStreamID: number, opaqueData: Buffer) => {
        if (this.session === session) {
          /* See the last paragraph of
           * https://github.com/grpc/proposal/blob/master/A8-client-side-keepalive.md#basic-keepalive */
          if (
            errorCode === http2.constants.NGHTTP2_ENHANCE_YOUR_CALM &&
            opaqueData.equals(tooManyPingsData)
          ) {
            this.keepaliveTimeMs = Math.min(
              2 * this.keepaliveTimeMs,
              KEEPALIVE_MAX_TIME_MS
            );
            logging.log(
              LogVerbosity.ERROR,
              `Connection to ${uriToString(this.channelTarget)} at ${
                this.subchannelAddressString
              } rejected by server because of excess pings. Increasing ping interval to ${
                this.keepaliveTimeMs
              } ms`
            );
          }
          this.trace(
            'connection closed by GOAWAY with code ' +
              errorCode
          );
          this.transitionToState(
            [ConnectivityState.CONNECTING, ConnectivityState.READY],
            ConnectivityState.IDLE
          );
        }
      }
    );
    session.once('error', (error) => {
      /* Do nothing here. Any error should also trigger a close event, which is
       * where we want to handle that.  */
      this.trace(
        'connection closed with error ' +
          (error as Error).message
      );
    });
    if (logging.isTracerEnabled(TRACER_NAME)) {
      session.on('remoteSettings', (settings: http2.Settings) => {
        this.trace(
          'new settings received' +
            (this.session !== session ? ' on the old connection' : '') +
            ': ' +
            JSON.stringify(settings)
        );
      });
      session.on('localSettings', (settings: http2.Settings) => {
        this.trace(
          'local settings acknowledged by remote' +
            (this.session !== session ? ' on the old connection' : '') +
            ': ' +
            JSON.stringify(settings)
        );
      });
    }
  }

  private startConnectingInternal() {
    /* Pass connection options through to the proxy so that it's able to
     * upgrade it's connection to support tls if needed.
     * This is a workaround for https://github.com/nodejs/node/issues/32922
     * See https://github.com/grpc/grpc-node/pull/1369 for more info. */
    const connectionOptions: ConnectionOptions =
      this.credentials._getConnectionOptions() || {};

    if ('secureContext' in connectionOptions) {
      connectionOptions.ALPNProtocols = ['h2'];
      // If provided, the value of grpc.ssl_target_name_override should be used
      // to override the target hostname when checking server identity.
      // This option is used for testing only.
      if (this.options['grpc.ssl_target_name_override']) {
        const sslTargetNameOverride = this.options[
          'grpc.ssl_target_name_override'
        ]!;
        connectionOptions.checkServerIdentity = (
          host: string,
          cert: PeerCertificate
        ): Error | undefined => {
          return checkServerIdentity(sslTargetNameOverride, cert);
        };
        connectionOptions.servername = sslTargetNameOverride;
      } else {
        if ('grpc.http_connect_target' in this.options) {
          /* This is more or less how servername will be set in createSession
           * if a connection is successfully established through the proxy.
           * If the proxy is not used, these connectionOptions are discarded
           * anyway */
          const targetPath = getDefaultAuthority(
            parseUri(this.options['grpc.http_connect_target'] as string) ?? {
              path: 'localhost',
            }
          );
          const hostPort = splitHostPort(targetPath);
          connectionOptions.servername = hostPort?.host ?? targetPath;
        }
      }
    }

    getProxiedConnection(
      this.subchannelAddress,
      this.options,
      connectionOptions
    ).then(
      (result) => {
        this.createSession(result);
      },
      (reason) => {
        this.transitionToState(
          [ConnectivityState.CONNECTING],
          ConnectivityState.TRANSIENT_FAILURE
        );
      }
    );
  }

  private handleDisconnect() {
    this.transitionToState(
      [ConnectivityState.READY],
      ConnectivityState.TRANSIENT_FAILURE);
    for (const listener of this.disconnectListeners.values()) {
      listener();
    }
  }

  /**
   * Initiate a state transition from any element of oldStates to the new
   * state. If the current connectivityState is not in oldStates, do nothing.
   * @param oldStates The set of states to transition from
   * @param newState The state to transition to
   * @returns True if the state changed, false otherwise
   */
  private transitionToState(
    oldStates: ConnectivityState[],
    newState: ConnectivityState
  ): boolean {
    if (oldStates.indexOf(this.connectivityState) === -1) {
      return false;
    }
    this.trace(
      ConnectivityState[this.connectivityState] +
        ' -> ' +
        ConnectivityState[newState]
    );
    if (this.channelzEnabled) {
      this.channelzTrace.addTrace('CT_INFO', ConnectivityState[this.connectivityState] + ' -> ' + ConnectivityState[newState]);
    }
    const previousState = this.connectivityState;
    this.connectivityState = newState;
    switch (newState) {
      case ConnectivityState.READY:
        this.stopBackoff();
        const session = this.session!;
        session.socket.once('close', () => {
          if (this.session === session) {
            this.handleDisconnect();
          }
        });
        if (this.keepaliveWithoutCalls) {
          this.startKeepalivePings();
        }
        break;
      case ConnectivityState.CONNECTING:
        this.startBackoff();
        this.startConnectingInternal();
        this.continueConnecting = false;
        break;
      case ConnectivityState.TRANSIENT_FAILURE:
        if (this.session) {
          this.session.close();
        }
        this.session = null;
        this.resetChannelzSocketInfo();
        this.stopKeepalivePings();
        /* If the backoff timer has already ended by the time we get to the
         * TRANSIENT_FAILURE state, we want to immediately transition out of
         * TRANSIENT_FAILURE as though the backoff timer is ending right now */
        if (!this.backoffTimeout.isRunning()) {
          process.nextTick(() => {
            this.handleBackoffTimer();
          });
        }
        break;
      case ConnectivityState.IDLE:
        if (this.session) {
          this.session.close();
        }
        this.session = null;
        this.resetChannelzSocketInfo();
        this.stopKeepalivePings();
        break;
      default:
        throw new Error(`Invalid state: unknown ConnectivityState ${newState}`);
    }
    /* We use a shallow copy of the stateListeners array in case a listener
     * is removed during this iteration */
    for (const listener of [...this.stateListeners]) {
      listener(this, previousState, newState);
    }
    return true;
  }

  /**
   * Check if the subchannel associated with zero calls and with zero channels.
   * If so, shut it down.
   */
  private checkBothRefcounts() {
    /* If no calls, channels, or subchannel pools have any more references to
     * this subchannel, we can be sure it will never be used again. */
    if (this.callRefcount === 0 && this.refcount === 0) {
      if (this.channelzEnabled) {
        this.channelzTrace.addTrace('CT_INFO', 'Shutting down');
      }
      this.transitionToState(
        [ConnectivityState.CONNECTING, ConnectivityState.READY],
        ConnectivityState.IDLE
      );
      if (this.channelzEnabled) {
        unregisterChannelzRef(this.channelzRef);
      }
    }
  }

  callRef() {
    this.refTrace(
      'callRefcount ' +
        this.callRefcount +
        ' -> ' +
        (this.callRefcount + 1)
    );
    if (this.callRefcount === 0) {
      if (this.session) {
        this.session.ref();
      }
      this.backoffTimeout.ref();
      if (!this.keepaliveWithoutCalls) {
        this.startKeepalivePings();
      }
    }
    this.callRefcount += 1;
  }

  callUnref() {
    this.refTrace(
      'callRefcount ' +
        this.callRefcount +
        ' -> ' +
        (this.callRefcount - 1)
    );
    this.callRefcount -= 1;
    if (this.callRefcount === 0) {
      if (this.session) {
        this.session.unref();
      }
      this.backoffTimeout.unref();
      if (!this.keepaliveWithoutCalls) {
        clearInterval(this.keepaliveIntervalId);
      }
      this.checkBothRefcounts();
    }
  }

  ref() {
    this.refTrace(
      'refcount ' +
        this.refcount +
        ' -> ' +
        (this.refcount + 1)
    );
    this.refcount += 1;
  }

  unref() {
    this.refTrace(
      'refcount ' +
        this.refcount +
        ' -> ' +
        (this.refcount - 1)
    );
    this.refcount -= 1;
    this.checkBothRefcounts();
  }

  unrefIfOneRef(): boolean {
    if (this.refcount === 1) {
      this.unref();
      return true;
    }
    return false;
  }

  createCall(metadata: Metadata, host: string, method: string, listener: InterceptingListener): SubchannelCall {
    const headers = metadata.toHttp2Headers();
    headers[HTTP2_HEADER_AUTHORITY] = host;
    headers[HTTP2_HEADER_USER_AGENT] = this.userAgent;
    headers[HTTP2_HEADER_CONTENT_TYPE] = 'application/grpc';
    headers[HTTP2_HEADER_METHOD] = 'POST';
    headers[HTTP2_HEADER_PATH] = method;
    headers[HTTP2_HEADER_TE] = 'trailers';
    let http2Stream: http2.ClientHttp2Stream;
    /* In theory, if an error is thrown by session.request because session has
     * become unusable (e.g. because it has received a goaway), this subchannel
     * should soon see the corresponding close or goaway event anyway and leave
     * READY. But we have seen reports that this does not happen
     * (https://github.com/googleapis/nodejs-firestore/issues/1023#issuecomment-653204096)
     * so for defense in depth, we just discard the session when we see an
     * error here.
     */
    try {
      http2Stream = this.session!.request(headers);
    } catch (e) {
      this.transitionToState(
        [ConnectivityState.READY],
        ConnectivityState.TRANSIENT_FAILURE
      );
      throw e;
    }
    this.flowControlTrace(
      'local window size: ' +
        this.session!.state.localWindowSize +
        ' remote window size: ' +
        this.session!.state.remoteWindowSize
    );
    const streamSession = this.session;
    this.internalsTrace(
      'session.closed=' + 
      streamSession!.closed + 
      ' session.destroyed=' + 
      streamSession!.destroyed + 
      ' session.socket.destroyed=' + 
      streamSession!.socket.destroyed);
    let statsTracker: SubchannelCallStatsTracker;
    if (this.channelzEnabled) {
      this.callTracker.addCallStarted();
      this.streamTracker.addCallStarted();
      statsTracker = {
        addMessageSent: () => {
          this.messagesSent += 1;
          this.lastMessageSentTimestamp = new Date();
        },
        addMessageReceived: () => {
          this.messagesReceived += 1;
        },
        onCallEnd: status => {
          if (status.code === Status.OK) {
            this.callTracker.addCallSucceeded();
          } else {
            this.callTracker.addCallFailed();
          }
        },
        onStreamEnd: success => {
          if (streamSession === this.session) {
            if (success) {
              this.streamTracker.addCallSucceeded();
            } else {
              this.streamTracker.addCallFailed();
            }
          }
        }
      }
    } else {
      statsTracker = {
        addMessageSent: () => {},
        addMessageReceived: () => {},
        onCallEnd: () => {},
        onStreamEnd: () => {}
      }
    }
    return new Http2SubchannelCall(http2Stream, statsTracker, listener, this, getNextCallNumber());
  }

  /**
   * If the subchannel is currently IDLE, start connecting and switch to the
   * CONNECTING state. If the subchannel is current in TRANSIENT_FAILURE,
   * the next time it would transition to IDLE, start connecting again instead.
   * Otherwise, do nothing.
   */
  startConnecting() {
    /* First, try to transition from IDLE to connecting. If that doesn't happen
     * because the state is not currently IDLE, check if it is
     * TRANSIENT_FAILURE, and if so indicate that it should go back to
     * connecting after the backoff timer ends. Otherwise do nothing */
    if (
      !this.transitionToState(
        [ConnectivityState.IDLE],
        ConnectivityState.CONNECTING
      )
    ) {
      if (this.connectivityState === ConnectivityState.TRANSIENT_FAILURE) {
        this.continueConnecting = true;
      }
    }
  }

  /**
   * Get the subchannel's current connectivity state.
   */
  getConnectivityState() {
    return this.connectivityState;
  }

  /**
   * Add a listener function to be called whenever the subchannel's
   * connectivity state changes.
   * @param listener
   */
  addConnectivityStateListener(listener: ConnectivityStateListener) {
    this.stateListeners.push(listener);
  }

  /**
   * Remove a listener previously added with `addConnectivityStateListener`
   * @param listener A reference to a function previously passed to
   *     `addConnectivityStateListener`
   */
  removeConnectivityStateListener(listener: ConnectivityStateListener) {
    const listenerIndex = this.stateListeners.indexOf(listener);
    if (listenerIndex > -1) {
      this.stateListeners.splice(listenerIndex, 1);
    }
  }

  addDisconnectListener(listener: () => void) {
    this.disconnectListeners.add(listener);
  }

  removeDisconnectListener(listener: () => void) {
    this.disconnectListeners.delete(listener);
  }

  /**
   * Reset the backoff timeout, and immediately start connecting if in backoff.
   */
  resetBackoff() {
    this.backoffTimeout.reset();
    this.transitionToState(
      [ConnectivityState.TRANSIENT_FAILURE],
      ConnectivityState.CONNECTING
    );
  }

  getAddress(): string {
    return this.subchannelAddressString;
  }

  getChannelzRef(): SubchannelRef {
    return this.channelzRef;
  }

  getRealSubchannel(): this {
    return this;
  }
}
