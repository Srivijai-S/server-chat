const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const cors = require("cors")
const crypto = require("crypto")

const app = express()
const server = http.createServer(app)
const io = socketIo(server, {
  cors: {
    origin: "https://realtime-chat-delta-eight.vercel.app", 
    methods: ["GET", "POST"],
  },
})

app.use(cors())
app.use(express.json())

// In-memory storage (use database in production)
const users = new Map()
const messages = []
const activeCalls = new Map()

// Encryption utilities
const ENCRYPTION_KEY = crypto.randomBytes(32)
const IV_LENGTH = 16

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipher("aes-256-cbc", ENCRYPTION_KEY)
  let encrypted = cipher.update(text, "utf8", "hex")
  encrypted += cipher.final("hex")
  return iv.toString("hex") + ":" + encrypted
}

function decrypt(text) {
  const textParts = text.split(":")
  const iv = Buffer.from(textParts.shift(), "hex")
  const encryptedText = textParts.join(":")
  const decipher = crypto.createDecipher("aes-256-cbc", ENCRYPTION_KEY)
  let decrypted = decipher.update(encryptedText, "hex", "utf8")
  decrypted += decipher.final("utf8")
  return decrypted
}

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id)

  // User login
  socket.on("user-login", (username) => {
    users.set(socket.id, {
      id: socket.id,
      username: username,
      status: "online",
    })

    // Broadcast updated user list
    const userList = Array.from(users.values())
    io.emit("users-updated", userList)

    console.log(`${username} logged in`)
  })

  // Handle messages
  socket.on("send-message", (message) => {
    const sender = users.get(socket.id)
    if (!sender) return

    // Store message (encrypted)
    const encryptedMessage = {
      ...message,
      content:message.content,
      timestamp: new Date(),
      encrypted: true,
    }

    messages.push(encryptedMessage)

    // Find recipient and send message
    const recipient = Array.from(users.values()).find((user) => user.username === message.to)
    if (recipient) {
      io.to(recipient.id).emit("message-received", encryptedMessage)
    }
  })

  // Call handling
  socket.on("initiate-call", (callData) => {
    const caller = users.get(socket.id)
    if (!caller) return

    // Update caller status
    users.set(socket.id, { ...caller, status: "calling" })

    // Find recipient
    const recipient = Array.from(users.values()).find((user) => user.username === callData.to)
      console.log("recipient",recipient)
    if (recipient) {
      // Store active call
      activeCalls.set(caller.username + "-" + recipient.username, {
        caller: caller.username,
        recipient: recipient.username,
        type: callData.type,
        status: "ringing",
      })
    

      // Notify recipient
      io.to(recipient.id).emit("call-incoming", callData)

      // Update user statuses
      users.set(recipient.id, { ...recipient, status: "calling" })
      io.emit("users-updated", Array.from(users.values()))
    }
  })

  socket.on("answer-call", (callData) => {
    const answerer = users.get(socket.id)
    if (!answerer) return

    // Find caller
    const caller = Array.from(users.values()).find((user) => user.username === callData.to)
    if (caller) {
      io.to(caller.id).emit("call-answered", callData)

      // Update call status
      const callKey = caller.username + "-" + answerer.username
      const call = activeCalls.get(callKey)
      if (call) {
        activeCalls.set(callKey, { ...call, status: "active" })
      }
    }
  })

  socket.on("end-call", (data) => {
    const user = users.get(socket.id)
    if (!user) return

    // Find other participant
    const otherUser = Array.from(users.values()).find((u) => u.username === data.to)
    if (otherUser) {
      io.to(otherUser.id).emit("call-ended")

      // Update statuses
      users.set(socket.id, { ...user, status: "online" })
      users.set(otherUser.id, { ...otherUser, status: "online" })

      // Remove active call
      activeCalls.delete(user.username + "-" + otherUser.username)
      activeCalls.delete(otherUser.username + "-" + user.username)

      io.emit("users-updated", Array.from(users.values()))
    }
  })

  socket.on("ice-candidate", (data) => {
    const sender = users.get(socket.id)
    if (!sender) return

    const recipient = Array.from(users.values()).find((user) => user.username === data.to)
    console.log( "Recee",recipient)
    if (recipient) {
      io.to(recipient.id).emit("ice-candidate", data.candidate)
    }
  })

  // Handle disconnect
  socket.on("disconnect", () => {
    const user = users.get(socket.id)
    if (user) {
      console.log(`${user.username} disconnected`)

      // Remove user
      users.delete(socket.id)

      // Clean up any active calls
      for (const [key, call] of activeCalls.entries()) {
        if (call.caller === user.username || call.recipient === user.username) {
          activeCalls.delete(key)

          // Notify other participant
          const otherUsername = call.caller === user.username ? call.recipient : call.caller
          const otherUser = Array.from(users.values()).find((u) => u.username === otherUsername)
          if (otherUser) {
            io.to(otherUser.id).emit("call-ended")
            users.set(otherUser.id, { ...otherUser, status: "online" })
          }
        }
      }

      // Broadcast updated user list
      io.emit("users-updated", Array.from(users.values()))
    }
  })
})

// REST API endpoints
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() })
})

app.get("/api/users", (req, res) => {
  res.json(Array.from(users.values()))
})

app.get("/api/messages/:user1/:user2", (req, res) => {
  const { user1, user2 } = req.params

  const userMessages = messages.filter(
    (msg) => (msg.from === user1 && msg.to === user2) || (msg.from === user2 && msg.to === user1),
  )

  // Decrypt messages for API response
  const decryptedMessages = userMessages.map((msg) => ({
    ...msg,
    content: decrypt(msg.content),
  }))

  res.json(decryptedMessages)
})

app.post("/api/messages", (req, res) => {
  const { from, to, content } = req.body

  if (!from || !to || !content) {
    return res.status(400).json({ error: "Missing required fields" })
  }

  const message = {
    id: Date.now().toString(),
    from,
    to,
    content: encrypt(content),
    timestamp: new Date(),
    encrypted: true,
  }

  messages.push(message)

  // Notify recipient via socket
  const recipient = Array.from(users.values()).find((user) => user.username === to)
  if (recipient) {
    io.to(recipient.id).emit("message-received", message)
  }

  res.json({ success: true, messageId: message.id })
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  console.log(`WebSocket server ready for connections`)
})
