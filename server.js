const express = require("express");
const http = require("http");
const mediasoup = require("mediasoup");
const WebSocket = require("ws");
const url = require("url");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  // WebSocket 서버 추가 설정
  clientTracking: true,
  // ping/pong으로 연결 상태 모니터링
  pingInterval: 30000,
  pingTimeout: 5000,
});

// Mediasoup 워커와 라우터를 저장할 맵
const workers = new Map();
const routers = new Map();

const config = {
  mediasoup: {
    worker: {
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
      logLevel: "warn",
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
    },
    router: {
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          clockRate: 90000,
          parameters: {
            "x-google-start-bitrate": 1000,
          },
        },
        {
          kind: "video",
          mimeType: "video/H264",
          clockRate: 90000,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "4d0032",
            "level-asymmetry-allowed": 1,
          },
        },
      ],
    },
    webRtcTransport: {
      listenIps: [
        {
          ip:
            process.env.NODE_ENV === "production"
              ? "0.0.0.0" // 프로덕션 환경에서는 모든 인터페이스에서 수신
              : "127.0.0.1", // 개발 환경
          announcedIp: "3.39.137.182",
        },
      ],
      initialAvailableOutgoingBitrate: 600000,
      minimumAvailableOutgoingBitrate: 300000,
      maxSctpMessageSize: 262144,
      maxIncomingBitrate: 1500000,
      // 추가 보안 설정
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      // DTLS 설정
      enableSctp: true,
      numSctpStreams: { OS: 1024, MIS: 1024 },
    },
  },
};

// WebSocket 연결 관리를 위한 맵
const connections = new Map();

// 연결 상태 모니터링
function heartbeat() {
  this.isAlive = true;
}

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      connections.delete(ws.userId);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

wss.on("close", () => {
  clearInterval(interval);
});

class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.participants = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.router = null;
  }

  async init() {
    // 워커가 없으면 생성
    if (workers.size === 0) {
      const worker = await mediasoup.createWorker(config.mediasoup.worker);
      workers.set(this.roomId, worker);

      worker.on("died", () => {
        console.error(
          "mediasoup worker died, exiting in 2 seconds... [pid:%d]",
          worker.pid
        );
        setTimeout(() => process.exit(1), 2000);
      });
    }

    const worker = workers.get(this.roomId);
    this.router = await worker.createRouter({
      mediaCodecs: config.mediasoup.router.mediaCodecs,
    });
    routers.set(this.roomId, this.router);
  }

  async createWebRtcTransport(participantId) {
    const transport = await this.router.createWebRtcTransport({
      ...config.mediasoup.webRtcTransport,
    });

    // DTLS 상태 변경 모니터링
    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed" || dtlsState === "failed") {
        console.log("Transport dtls state changed to", dtlsState);
        transport.close();
      }
    });

    // ICE 상태 변경 모니터링
    transport.on("icestatechange", (iceState) => {
      console.log("Transport ice state changed to", iceState);
    });

    return {
      transport,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
      },
    };
  }
}

const rooms = new Map();

wss.on("connection", async (ws, req) => {
  console.log("WebSocket connection attempt:", {
    ip: req.headers["x-real-ip"] || req.socket.remoteAddress,
    url: req.url,
    headers: req.headers,
  });

  const query = url.parse(req.url, true).query;
  const roomId = query.roomId;
  const userId = query.userId;

  ws.isAlive = true;
  ws.userId = userId;
  ws.on("pong", heartbeat);
  connections.set(userId, ws);

  if (!rooms.has(roomId)) {
    const room = new Room(roomId);
    await room.init();
    rooms.set(roomId, room);
  }

  const room = rooms.get(roomId);
  let producerTransport;
  let consumerTransport;

  ws.on("message", async (message) => {
    try {
      const { event, data } = JSON.parse(message);

      switch (event) {
        case "getRouterRtpCapabilities": {
          ws.send(
            JSON.stringify({
              event: "routerRtpCapabilities",
              data: room.router.rtpCapabilities,
            })
          );
          break;
        }

        case "createProducerTransport": {
          const { transport, params } =
            await room.createWebRtcTransport(userId);
          producerTransport = transport;
          ws.send(
            JSON.stringify({
              event: "producerTransportCreated",
              data: params,
            })
          );
          break;
        }

        case "createConsumerTransport": {
          const { transport, params } =
            await room.createWebRtcTransport(userId);
          consumerTransport = transport;
          ws.send(
            JSON.stringify({
              event: "consumerTransportCreated",
              data: params,
            })
          );
          break;
        }

        case "connectProducerTransport": {
          await producerTransport.connect({
            dtlsParameters: data.dtlsParameters,
          });
          break;
        }

        case "connectConsumerTransport": {
          await consumerTransport.connect({
            dtlsParameters: data.dtlsParameters,
          });
          break;
        }

        case "produce": {
          const producer = await producerTransport.produce({
            kind: data.kind,
            rtpParameters: data.rtpParameters,
          });

          room.producers.set(producer.id, producer);

          producer.on("transportclose", () => {
            producer.close();
            room.producers.delete(producer.id);
          });

          ws.send(
            JSON.stringify({
              event: "produced",
              data: { id: producer.id },
            })
          );
          break;
        }

        case "consume": {
          const producer = room.producers.get(data.producerId);
          if (!producer) {
            ws.send(
              JSON.stringify({
                event: "error",
                data: "producer not found",
              })
            );
            break;
          }

          const consumer = await consumerTransport.consume({
            producerId: data.producerId,
            rtpCapabilities: data.rtpCapabilities,
            paused: true,
          });

          room.consumers.set(consumer.id, consumer);

          consumer.on("transportclose", () => {
            consumer.close();
            room.consumers.delete(consumer.id);
          });

          ws.send(
            JSON.stringify({
              event: "consumed",
              data: {
                id: consumer.id,
                producerId: producer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
              },
            })
          );
          break;
        }

        case "resumeConsumer": {
          const consumer = room.consumers.get(data.consumerId);
          if (consumer) {
            await consumer.resume();
          }
          break;
        }
      }
    } catch (error) {
      console.error("Message handling error:", error);
      ws.send(
        JSON.stringify({
          event: "error",
          data: error.message,
        })
      );
    }
  });

  ws.on("error", (error) => {
    console.error(`WebSocket error for user ${userId}:`, error);
    // 클라이언트에게 에러 알림
    ws.send(
      JSON.stringify({
        event: "error",
        data: {
          message: "WebSocket error occurred",
          code: error.code,
        },
      })
    );
  });

  ws.on("close", () => {
    connections.delete(userId);
    if (producerTransport) {
      producerTransport.close();
    }
    if (consumerTransport) {
      consumerTransport.close();
    }

    const room = rooms.get(roomId);
    if (room?.participants.size === 0) {
      const worker = workers.get(roomId);
      if (worker) {
        worker.close();
        workers.delete(roomId);
      }
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(8080, () => {
  console.log(`Mediasoup Server is listening on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Closing server...");
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
});
