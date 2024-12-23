const express = require("express");
const app = express();
const cors = require("cors");
const mediasoup = require("mediasoup");
const fs = require("fs");

const PORT = 8000;
const server = require("http").createServer(app);
const io = require("socket.io")(server, {
  path: "/mediasoup",
  cors: {
    origin: "https://minoriedu.com",
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  },
  transports: ["websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 30000,
  allowEIO3: true,
  maxHttpBufferSize: 1e8,
  perMessageDeflate: {
    threshold: 1024,
    zlibInflateOptions: {
      chunkSize: 16 * 1024,
    },
    zlibDeflateOptions: {
      level: 6,
    },
  },
});

// WebSocket 연결 상태 모니터링
io.engine.on("connection_error", (err) => {
  console.error("Connection error:", {
    code: err.code,
    message: err.message,
    context: err.context,
    headers: err.req?.headers,
    url: err.req?.url,
    timestamp: new Date().toISOString(),
  });
});

// mediasoup 워커 설정
const createWorker = async () => {
  try {
    worker = await mediasoup.createWorker({
      rtcMinPort: 2000,
      rtcMaxPort: 2020,
      logLevel: "debug",
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
      dtlsCertificateFile: "/app/ssl/crt.pem",
      dtlsPrivateKeyFile: "/app/ssl/key.pem",
    });

    worker.on("died", (error) => {
      console.error("mediasoup worker died:", error);
      setTimeout(() => process.exit(1), 2000);
    });

    console.log(`Worker created with pid ${worker.pid}`);
    return worker;
  } catch (error) {
    console.error("Worker creation failed:", error);
    throw error;
  }
};

// 연결 디버깅을 위한 미들웨어 추가
io.use((socket, next) => {
  console.log("New connection attempt:", {
    id: socket.id,
    handshake: socket.handshake,
    timestamp: new Date().toISOString(),
  });
  next();
});

// 에러 핸들링 강화
io.engine.on("connection_error", (err) => {
  console.error("Connection error:", {
    code: err.code,
    message: err.message,
    context: err.context,
    timestamp: new Date().toISOString(),
    stack: err.stack,
  });
});

// Rate limiting 추가
const rateLimit = require("express-rate-limit");
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15분
  max: 100, // IP당 최대 요청 수
});

app.use(limiter);
app.use(cors());

const connections = io.of("/mediasoup");

// 에러 핸들링 강화
io.engine.on("connection_error", (err) => {
  console.error("Connection error:", {
    code: err.code,
    message: err.message,
    context: err.context,
    timestamp: new Date().toISOString(),
    stack: err.stack,
  });
});

// 연결 모니터링
io.engine.on("initial_headers", (headers, req) => {
  console.log("Socket.IO Initial headers:", {
    url: req.url,
    method: req.method,
    headers: {
      ...headers,
      "x-forwarded-proto": req.headers["x-forwarded-proto"],
      "x-forwarded-port": req.headers["x-forwarded-port"],
    },
    timestamp: new Date().toISOString(),
  });
});

io.engine.on("headers", (headers, req) => {
  console.log("Socket.IO Headers:", {
    url: req.url,
    method: req.method,
    headers: headers,
    query: req.query,
    timestamp: new Date().toISOString(),
  });
});

// 헬스 체크 엔드포인트 추가
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Worker Pool 관리
const WorkerPool = {
  workers: [],
  index: 0,

  async init(numWorkers = require("os").cpus().length) {
    for (let i = 0; i < numWorkers; i++) {
      const worker = await createWorker();
      this.workers.push(worker);
    }
    console.log(`Initialized ${numWorkers} workers`);
  },

  getWorker() {
    const worker = this.workers[this.index];
    this.index = (this.index + 1) % this.workers.length;
    return worker;
  },
};

app.get("/", (req, res) => {
  res.send("hi");
});

let worker;
let rooms = {}; // { roomName1: { Router, rooms: [ sicketId1, ... ] }, ...}
let peers = {}; // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
let transports = []; // [ { socketId1, roomName1, transport, consumer }, ... ]
let producers = []; // [ { socketId1, roomName1, producer, }, ... ]
let consumers = []; // [ { socketId1, roomName1, consumer, }, ... ]

// We create a Worker as soon as our application starts
worker = createWorker();

// This is an Array of RtpCapabilities
// list of media codecs supported by mediasoup ...
const mediaCodecs = [
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
];

io.engine.on("connection_error", (err) => {
  console.error("Connection error:", {
    code: err.code,
    message: err.message,
    context: err.context,
  });
});

connections.on("connection", async (socket) => {
  console.log("New WebSocket connection:", socket.id);

  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });

  const removeItems = (items, socketId, type) => {
    items.forEach((item) => {
      if (item.socketId === socket.id) {
        item[type].close();
      }
    });
    items = items.filter((item) => item.socketId !== socket.id);

    return items;
  };

  socket.on("disconnect", () => {
    console.log("Client disconnected:", {
      id: socket.id,
      reason,
    });
    // user left room
    consumers = removeItems(consumers, socket.id, "consumer");
    producers = removeItems(producers, socket.id, "producer");
    transports = removeItems(transports, socket.id, "transport");
    console.log(peers);
    if (!peers[socket.id] || !peers[socket.id].roomName) {
      return;
    }
    const { roomName } = peers[socket.id];
    delete peers[socket.id];

    // remove socket from room
    rooms[roomName] = {
      router: rooms[roomName].router,
      peers: rooms[roomName].peers.filter((socketId) => socketId !== socket.id),
    };
  });

  socket.on("joinRoom", async ({ roomName }, callback) => {
    // create Router if it does not exist
    // const router1 = rooms[roomName] && rooms[roomName].get('data').router || await createRoom(roomName, socket.id)
    const router1 = await createRoom(roomName, socket.id);

    peers[socket.id] = {
      socket,
      roomName, // Name for the Router this Peer joined
      transports: [],
      producers: [],
      consumers: [],
      peerDetails: {
        name: "",
        isAdmin: false, // Is this Peer the Admin?
      },
    };

    // get Router RTP Capabilities
    const rtpCapabilities = router1.rtpCapabilities;

    // call callback from the client and send back the rtpCapabilities
    callback({ rtpCapabilities });
  });

  const createRoom = async (roomName, socketId) => {
    // worker.createRouter(options)
    // options = { mediaCodecs, appData }
    // mediaCodecs -> defined above
    // appData -> custom application data - we are not supplying any
    // none of the two are required
    let router1;
    let peers = [];
    if (rooms[roomName]) {
      router1 = rooms[roomName].router;
      peers = rooms[roomName].peers || [];
    } else {
      router1 = await worker.createRouter({ mediaCodecs });
    }

    console.log(`Router ID: ${router1.id}`, peers.length);

    rooms[roomName] = {
      router: router1,
      peers: [...peers, socketId],
    };

    return router1;
  };

  // Client emits a request to create server side Transport
  // We need to differentiate between the producer and consumer transports
  socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
    // get Room Name from Peer's properties
    if (!peers[socket.id] || !peers[socket.id].roomName) {
      return;
    }
    const roomName = peers[socket.id].roomName;

    // get Router (Room) object this peer is in based on RoomName
    const router = rooms[roomName].router;

    createWebRtcTransport(router).then(
      (transport) => {
        callback({
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          },
        });

        // add transport to Peer's properties
        addTransport(transport, roomName, consumer);
      },
      (error) => {
        console.log(error);
      }
    );
  });

  const addTransport = (transport, roomName, consumer) => {
    transports = [
      ...transports,
      { socketId: socket.id, transport, roomName, consumer },
    ];

    peers[socket.id] = {
      ...peers[socket.id],
      transports: [...peers[socket.id].transports, transport.id],
    };
  };

  const addProducer = (producer, roomName) => {
    producers = [...producers, { socketId: socket.id, producer, roomName }];

    peers[socket.id] = {
      ...peers[socket.id],
      producers: [...peers[socket.id].producers, producer.id],
    };
  };

  const addConsumer = (consumer, roomName) => {
    // add the consumer to the consumers list
    consumers = [...consumers, { socketId: socket.id, consumer, roomName }];

    // add the consumer id to the peers list
    peers[socket.id] = {
      ...peers[socket.id],
      consumers: [...peers[socket.id].consumers, consumer.id],
    };
  };

  socket.on("getProducers", (callback) => {
    //return all producer transports
    const { roomName } = peers[socket.id];

    let producerList = [];
    producers.forEach((producerData) => {
      if (
        producerData.socketId !== socket.id &&
        producerData.roomName === roomName
      ) {
        producerList = [...producerList, producerData.producer.id];
      }
    });

    // return the producer list back to the client
    callback(producerList);
  });

  const informConsumers = (roomName, socketId, id) => {
    console.log(`just joined, id ${id} ${roomName}, ${socketId}`);
    // A new producer just joined
    // let all consumers to consume this producer
    producers.forEach((producerData) => {
      if (
        producerData.socketId !== socketId &&
        producerData.roomName === roomName
      ) {
        const producerSocket = peers[producerData.socketId].socket;
        // use socket to send producer id to producer
        producerSocket.emit("new-producer", { producerId: id });
      }
    });
  };

  const getTransport = (socketId) => {
    const [producerTransport] = transports.filter(
      (transport) => transport.socketId === socketId && !transport.consumer
    );
    return producerTransport.transport;
  };

  // see client's socket.emit('transport-connect', ...)
  socket.on("transport-connect", ({ dtlsParameters }) => {
    console.log("DTLS PARAMS... ", { dtlsParameters });

    getTransport(socket.id).connect({ dtlsParameters });
  });

  // see client's socket.emit('transport-produce', ...)
  socket.on(
    "transport-produce",
    async ({ kind, rtpParameters, appData }, callback) => {
      // call produce based on the prameters from the client
      const producer = await getTransport(socket.id).produce({
        kind,
        rtpParameters,
      });

      // add producer to the producers array
      const { roomName } = peers[socket.id];

      addProducer(producer, roomName);

      informConsumers(roomName, socket.id, producer.id);

      console.log("Producer ID: ", producer.id, producer.kind);

      producer.on("transportclose", () => {
        console.log("transport for this producer closed ");
        producer.close();
      });

      // Send back to the client the Producer's id
      callback({
        id: producer.id,
        producersExist: producers.length > 1 ? true : false,
      });
    }
  );

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on(
    "transport-recv-connect",
    async ({ dtlsParameters, serverConsumerTransportId }) => {
      console.log(`DTLS PARAMS: ${dtlsParameters}`);
      const consumerTransport = transports.find(
        (transportData) =>
          transportData.consumer &&
          transportData.transport.id == serverConsumerTransportId
      ).transport;
      await consumerTransport.connect({ dtlsParameters });
    }
  );

  socket.on(
    "consume",
    async (
      { rtpCapabilities, remoteProducerId, serverConsumerTransportId },
      callback
    ) => {
      try {
        const { roomName } = peers[socket.id];
        const router = rooms[roomName].router;
        let consumerTransport = transports.find(
          (transportData) =>
            transportData.consumer &&
            transportData.transport.id == serverConsumerTransportId
        ).transport;

        // check if the router can consume the specified producer
        if (
          router.canConsume({
            producerId: remoteProducerId,
            rtpCapabilities,
          })
        ) {
          // transport can now consume and return a consumer
          const consumer = await consumerTransport.consume({
            producerId: remoteProducerId,
            rtpCapabilities,
            paused: true,
          });

          consumer.on("transportclose", () => {
            console.log("transport close from consumer");
          });

          consumer.on("producerclose", () => {
            console.log("producer of consumer closed");
            socket.emit("producer-closed", { remoteProducerId });

            consumerTransport.close([]);
            transports = transports.filter(
              (transportData) =>
                transportData.transport.id !== consumerTransport.id
            );
            consumer.close();
            consumers = consumers.filter(
              (consumerData) => consumerData.consumer.id !== consumer.id
            );
          });

          addConsumer(consumer, roomName);

          // from the consumer extract the following params
          // to send back to the Client
          const params = {
            id: consumer.id,
            producerId: remoteProducerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            serverConsumerId: consumer.id,
          };

          // send the parameters to the client
          callback({ params });
        }
      } catch (error) {
        console.log(error.message);
        callback({
          params: {
            error: error,
          },
        });
      }
    }
  );

  socket.on("consumer-resume", async ({ serverConsumerId }) => {
    console.log("consumer resume");
    const { consumer } = consumers.find(
      (consumerData) => consumerData.consumer.id === serverConsumerId
    );
    await consumer.resume();
  });
});

const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
    try {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: "0.0.0.0", // replace with relevant IP address
            announcedIp: "3.39.137.182",
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
        minimumAvailableOutgoingBitrate: 600000,
        maxSctpMessageSize: 262144,
        maxIncomingBitrate: 1500000,
        // DTLS support
        enableSctp: true,
        numSctpStreams: {
          OS: 1024,
          MIS: 1024,
        },
      };

      // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
      let transport = await router.createWebRtcTransport(
        webRtcTransport_options
      );
      console.log(`transport id: ${transport.id}`);

      transport.on("dtlsstatechange", (dtlsState) => {
        if (dtlsState === "failed" || dtlsState === "closed") {
          console.error("DTLS state changed to", dtlsState);
        }
      });

      transport.on("close", () => {
        console.log("transport closed");
      });

      resolve(transport);
    } catch (error) {
      reject(error);
    }
  });
};

const handleError = (error) => {
  console.error("Error occurred:", error);
  // 클라이언트에 에러 알림
  socket.emit("error", {
    type: "transport-error",
    message: error.message,
  });
};

const cleanup = (socketId) => {
  try {
    console.log(`Cleaning up resources for socket ${socketId}`);

    // Producers 정리
    producers = removeItems(producers, socketId, "producer");

    // Consumers 정리
    consumers = removeItems(consumers, socketId, "consumer");

    // Transports 정리
    transports = removeItems(transports, socketId, "transport");

    // Peer 정리
    if (peers[socketId]) {
      const { roomName } = peers[socketId];
      delete peers[socketId];

      // Room에서 제거
      if (rooms[roomName]) {
        rooms[roomName].peers = rooms[roomName].peers.filter(
          (id) => id !== socketId
        );

        // Room이 비었으면 제거
        if (rooms[roomName].peers.length === 0) {
          console.log(`Closing empty room: ${roomName}`);
          rooms[roomName].router.close();
          delete rooms[roomName];
        }
      }
    }
  } catch (error) {
    console.error(`Error during cleanup for socket ${socketId}:`, error);
  }
};

server.listen(PORT, () => {
  console.log("server is running on", PORT);
});

// 에러 핸들링 추가
io.on("connect_error", (err) => {
  console.error("Socket.IO connection error:", err);
});
