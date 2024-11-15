app.get("/healthcheck", (req, res) => {
  res.status(200).send("OK");
});

app.get("/mediasoup/healthcheck", (req, res) => {
  res.status(200).send("OK");
});
