const express = require("express");
const http = require("http");
const mediasoup = require("mediasoup");
const WebSocket = require("ws");
const url = require("url");

const app = express();

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  clientTracking: true,
  pingInterval: 10000,
  pingTimeout: 5000,
  perMessageDeflate: false, // 성능 향상을 위해 비활성화
});

// Mediasoup 워커와 라우터를 저장할 맵
const workers = new Map();
const routers = new Map();

const config = {
  mediasoup: {
    worker: {
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
      logLevel: "debug",
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
          ip: "0.0.0.0",
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
    try {
      if (workers.size === 0) {
        const worker = await mediasoup.createWorker(config.mediasoup.worker);
        workers.set(this.roomId, worker);

        worker.on("died", () => {
          console.error(
            "MediaSoup worker died, exiting in 2 seconds... [pid:%d]",
            worker.pid
          );
          setTimeout(() => process.exit(1), 2000);
        });

        console.log("Created new MediaSoup worker");
      }

      const worker = workers.get(this.roomId);
      this.router = await worker.createRouter({
        mediaCodecs: config.mediasoup.router.mediaCodecs,
      });
      routers.set(this.roomId, this.router);

      console.log(`Initialized room: ${this.roomId}`);
      return true;
    } catch (error) {
      console.error("Room initialization failed:", error);
      return false;
    }
  }

  async createWebRtcTransport(participantId) {
    try {
      const transport = await this.router.createWebRtcTransport({
        ...config.mediasoup.webRtcTransport,
      });

      console.log(`Created WebRTC transport for participant: ${participantId}`);

      transport.on("dtlsstatechange", (dtlsState) => {
        console.log("Transport dtls state changed to", dtlsState);
        if (dtlsState === "closed" || dtlsState === "failed") {
          transport.close();
        }
      });

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
    } catch (error) {
      console.error("Failed to create WebRTC transport:", error);
      throw error;
    }
  }
}

const rooms = new Map();

wss.on("connection", async (ws, req) => {
  const ip =
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress;
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const query = url.parse(req.url, true).query;
  const roomId = query.roomId;
  const userId = query.userId;

  console.log("New WebSocket connection:", {
    ip,
    protocol,
    roomId,
    userId,
    headers: req.headers,
    time: new Date().toISOString(),
  });

  ws.isAlive = true;
  ws.userId = userId;
  ws.on("pong", heartbeat);
  connections.set(userId, ws);

  try {
    if (!rooms.has(roomId)) {
      const room = new Room(roomId);
      const initialized = await room.init();
      if (!initialized) {
        throw new Error("Failed to initialize room");
      }
      rooms.set(roomId, room);
      console.log(`Created new room: ${roomId}`);
    }

    const room = rooms.get(roomId);
    let producerTransport;
    let consumerTransport;

    // 연결 성공 알림
    ws.send(
      JSON.stringify({
        event: "connected",
        data: {
          userId,
          roomId,
          timestamp: Date.now(),
        },
      })
    );

    ws.on("message", async (message) => {
      try {
        const { event, data } = JSON.parse(message);
        console.log(`Received ${event} from user ${userId}`);

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
            console.log(`New producer created: ${producer.id}`);

            producer.on("transportclose", () => {
              console.log(`Producer transport closed: ${producer.id}`);
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
              console.log(`Producer not found: ${data.producerId}`);
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
            console.log(`New consumer created: ${consumer.id}`);

            consumer.on("transportclose", () => {
              console.log(`Consumer transport closed: ${consumer.id}`);
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
              console.log(`Consumer resumed: ${data.consumerId}`);
            }
            break;
          }
        }
      } catch (error) {
        console.error("Message handling error:", error);
        ws.send(
          JSON.stringify({
            event: "error",
            data: {
              message: error.message,
              code: error.code,
            },
          })
        );
      }
    });

    ws.on("error", (error) => {
      console.error(`WebSocket error for user ${userId}:`, error);
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
      console.log(`Client disconnected: ${userId} from room ${roomId}`);
      connections.delete(userId);

      if (producerTransport) {
        producerTransport.close();
      }
      if (consumerTransport) {
        consumerTransport.close();
      }

      if (room?.participants.size === 0) {
        const worker = workers.get(roomId);
        if (worker) {
          worker.close();
          workers.delete(roomId);
        }
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted`);
      }
    });
  } catch (error) {
    console.error("Connection setup error:", error);
    ws.close(1011, "Server setup error");
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`MediaSoup Server is listening on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Closing server...");
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
});
