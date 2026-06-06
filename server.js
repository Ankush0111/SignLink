const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const cors     = require("cors");
const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect("mongodb://localhost:27017/signLanguageDB")
  .then(() => console.log(" MongoDB connected"))
  .catch(err => console.error(" MongoDB error:", err));

const User = mongoose.model("User", new mongoose.Schema({
  username: { type: String, required: true },
  email:    { type: String, required: true, unique: true },
  password: { type: String, required: true },
}));

app.get("/", (_, res) => res.send("Sign Language Backend Running"));

app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;
  try {
    if (await User.findOne({ email: email.toLowerCase() }))
      return res.json({ status: "exist" });
    const hash = await bcrypt.hash(password, 10);
    await new User({ username, email: email.toLowerCase(), password: hash }).save();
    res.json({ status: "notexist" });
  } catch (err) {
    res.status(500).json({ message: "Server error during registration." });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.json({ status: "notmatch" });
    res.json({ status: "exist", name: user.username });
  } catch (err) {
    res.status(500).json({ message: "Server error during login." });
  }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

// rooms: Map<roomId, Map<socketId, { id, name }>>
const rooms = new Map();

io.on("connection", socket => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on("joinRoom", ({ roomId, userName }) => {
    socket.join(roomId);
    socket.data.roomId   = roomId;
    socket.data.userName = userName;

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);

    // Tell the newcomer about every existing peer
    const others = [];
    room.forEach(u => others.push({ id: u.id, name: u.name }));
    socket.emit("allUsers", others);
    console.log(`  ↳ "${userName}" joined room "${roomId}" | existing: ${others.length}`);

    // Tell everyone else about the newcomer
    socket.to(roomId).emit("userJoined", { id: socket.id, name: userName });

    room.set(socket.id, { id: socket.id, name: userName });
  });

  // Unified WebRTC signal relay — handles SDP offer/answer + all ICE candidates
  socket.on("signal", ({ to, signal }) => {
    io.to(to).emit("signal", { from: socket.id, signal });
  });

  // Real-time Chat Relay Handler
  socket.on("chatMessage", ({ roomId, msg, senderName }) => {
    socket.to(roomId).emit("chatMessage", { msg, senderName });
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
    const { roomId } = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.delete(socket.id);
    if (room.size === 0) rooms.delete(roomId);
    socket.to(roomId).emit("userLeft", socket.id);
  });
});

server.listen(5000, () => console.log(" Server running on port 5000"));