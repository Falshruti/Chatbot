// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ─── User Store (local JSON file) ───────────────────────────────────────────
const USERS_FILE = path.join(__dirname, "users.json");

function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ─── Gemini Model Fallback List ──────────────────────────────────────────────
const FALLBACK_GEMINI_MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-1.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-flash-latest",
  "gemini-pro-latest",
].filter(Boolean);

function isModelNotFoundError(error) {
  const message = error?.message || String(error);
  return /not found|unsupported|404|not supported/i.test(message);
}

function isInvalidApiKeyError(error) {
  const message = error?.message || String(error);
  return /API key not valid|API_KEY_INVALID|invalid key/i.test(message);
}

async function createChatResponse(apiKey, modelNames, systemPrompt, chatHistory, message) {
  const errors = [];
  const genAI = new GoogleGenerativeAI(apiKey);

  for (const modelName of modelNames) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName, systemInstruction: systemPrompt });
      const chat = model.startChat({ history: chatHistory });
      const result = await chat.sendMessage(message);
      return { reply: result.response.text(), modelName };
    } catch (error) {
      const message = error?.message || String(error);
      errors.push(`${modelName}: ${message}`);
      if (isInvalidApiKeyError(error)) {
        throw new Error("Invalid API key. Please check your GEMINI_API_KEY in the .env file.");
      }
      console.warn(`Gemini model check failed for ${modelName}: ${message}`);
    }
  }

  throw new Error(`No available Gemini model found. Tried: ${modelNames.join(", ")}. Errors: ${errors.join(" | ")}`);
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || "chatbot-ui-secret-key-change-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if using HTTPS
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Request logging
app.use((req, res, next) => {
  if (req.method !== "OPTIONS") {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  }
  next();
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  // For API requests return JSON, for page requests redirect
  if (req.headers["content-type"] === "application/json" ||
      (req.headers["content-type"] || "").startsWith("multipart/form-data") ||
      req.path.startsWith("/chat") ||
      req.path.startsWith("/upload") ||
      req.path.startsWith("/image-proxy")) {
    return res.status(401).json({ error: "Not authenticated. Please log in." });
  }
  res.redirect("/login");
}

// ─── Multer — in-memory file upload (max 20MB) ────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp",
      "image/gif",
      "text/plain",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Supported: PDF, PNG, JPG, WEBP, GIF, TXT`));
    }
  }
});

// ─── Auth Routes ─────────────────────────────────────────────────────────────

// Sign up
app.post("/auth/signup", async (req, res) => {
  try {
    const { email, password, firstname, lastname } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    const users = readUsers();
    const existing = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const newUser = {
      id: "user_" + Date.now(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      firstname: (firstname || "").trim(),
      lastname: (lastname || "").trim(),
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    writeUsers(users);

    // Auto-login after signup
    req.session.userId = newUser.id;
    req.session.userEmail = newUser.email;
    req.session.userName = [newUser.firstname, newUser.lastname].filter(Boolean).join(" ") || newUser.email.split("@")[0];

    console.log(`New user registered: ${newUser.email}`);
    res.json({ success: true, user: { email: newUser.email, name: req.session.userName } });

  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const users = readUsers();
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase().trim());

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.userName = [user.firstname, user.lastname].filter(Boolean).join(" ") || user.email.split("@")[0];

    console.log(`User logged in: ${user.email}`);
    res.json({ success: true, user: { email: user.email, name: req.session.userName } });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Logout
app.post("/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Logout error:", err);
    res.json({ success: true });
  });
});

// Get current user (used by frontend to check auth state)
app.get("/auth/me", (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({
      id: req.session.userId,
      email: req.session.userEmail,
      name: req.session.userName
    });
  }
  res.status(401).json({ error: "Not authenticated" });
});

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(__dirname));

// Login page (public)
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

// Main chat page (protected)
app.get("/", (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect("/login");
  }
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─── File Upload Route (Protected) ───────────────────────────────────────────
app.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const apiKey = (process.env.GEMINI_API_KEY || "").trim();
    if (!apiKey) {
      return res.status(400).json({ error: "API Key is missing. Please set GEMINI_API_KEY in .env" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const { mimetype, buffer, originalname } = req.file;
    const userMessage = (req.body.message || "").trim();
    const modelName = req.body.model || "gemini-2.5-flash";

    const genAI = new GoogleGenerativeAI(apiKey);
    let reply = "";
    let usedModel = modelName;

    // ── PDF: extract text then send to Gemini ──────────────────────────────
    if (mimetype === "application/pdf") {
      console.log(`Processing PDF: ${originalname} (${buffer.length} bytes)`);
      let pdfText = "";
      try {
        const parser = new PDFParse({ data: buffer });
        const parsed = await parser.getText();
        pdfText = parsed.text.trim();
      } catch (pdfErr) {
        console.error("PDF parse error:", pdfErr.message);
        return res.status(400).json({ error: "Could not read the PDF file. Make sure it contains readable text (not scanned)." });
      }

      if (!pdfText || pdfText.length < 50) {
        return res.status(400).json({ error: "PDF appears to be empty or is a scanned image — no readable text found." });
      }

      // Truncate if very long (keep ~15,000 chars for context window)
      const truncatedText = pdfText.length > 15000 ? pdfText.substring(0, 15000) + "\n\n[...document truncated for length...]" : pdfText;

      const defaultQuestion = userMessage ||
        "Please analyze this document. If it looks like a resume or CV, suggest 10 companies I should apply to based on my skills and experience, explain why each is a good fit, and give me tips to improve my resume. If it is another type of document, summarize it and provide useful insights.";

      const prompt = `The user has uploaded a PDF document named "${originalname}".\n\nHere is the full extracted text:\n\n---\n${truncatedText}\n---\n\nUser's question: ${defaultQuestion}`;

      const modelNames = [modelName, ...FALLBACK_GEMINI_MODELS.filter(m => m !== modelName)];
      const result = await createChatResponse(apiKey, modelNames, 
        "You are a highly skilled career advisor, document analyst, and AI assistant. When given a resume or CV, provide specific, actionable company suggestions with reasons. Be detailed and helpful.",
        [],
        prompt
      );
      reply = result.reply;
      usedModel = result.modelName;
    }

    // ── Image: send to Gemini Vision ──────────────────────────────────────
    else if (mimetype.startsWith("image/")) {
      console.log(`Processing image: ${originalname} (${mimetype})`);
      const base64Image = buffer.toString("base64");
      const defaultQuestion = userMessage || "Please describe what you see in this image in detail. If it contains text (like a document or resume), read and analyze it.";

      // Try vision-capable models
      const visionModels = [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-flash-latest",
      ];

      let lastErr;
      for (const vModel of visionModels) {
        try {
          const model = genAI.getGenerativeModel({ model: vModel });
          const result = await model.generateContent([
            { text: defaultQuestion },
            { inlineData: { mimeType: mimetype, data: base64Image } }
          ]);
          reply = result.response.text();
          usedModel = vModel;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`Vision model ${vModel} failed:`, err.message);
        }
      }

      if (!reply) {
        throw lastErr || new Error("All vision models failed.");
      }
    }

    // ── Plain text file ───────────────────────────────────────────────────
    else if (mimetype === "text/plain") {
      const textContent = buffer.toString("utf8").substring(0, 15000);
      const defaultQuestion = userMessage || "Please analyze this text document and provide a helpful summary and insights.";
      const prompt = `The user has uploaded a text file named "${originalname}".\n\nContent:\n---\n${textContent}\n---\n\nUser question: ${defaultQuestion}`;

      const modelNames = [modelName, ...FALLBACK_GEMINI_MODELS.filter(m => m !== modelName)];
      const result = await createChatResponse(apiKey, modelNames, 
        "You are a helpful AI assistant that analyzes documents and provides detailed, actionable insights.",
        [],
        prompt
      );
      reply = result.reply;
      usedModel = result.modelName;
    }

    console.log(`File processed with model: ${usedModel}`);
    res.json({ reply, model: usedModel, filename: originalname, fileType: mimetype });

  } catch (err) {
    console.error("Upload/analysis error:", err);
    if (err.message && err.message.includes("Unsupported file type")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message || "Failed to process the uploaded file." });
  }
});

// ─── Image Proxy ──────────────────────────────────────────────────────────────
app.get("/image-proxy", requireAuth, (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url parameter");

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!parsedUrl.hostname.endsWith("pollinations.ai")) {
      return res.status(403).send("Only pollinations.ai URLs allowed");
    }
  } catch (e) {
    return res.status(400).send("Invalid URL");
  }

  const protocol = parsedUrl.protocol === "https:" ? https : http;
  const request = protocol.get(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ChatbotUI/1.0)" } }, (proxyRes) => {
    res.set("Content-Type", proxyRes.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=3600");
    proxyRes.pipe(res);
  });

  request.on("error", (err) => {
    console.error("Image proxy error:", err.message);
    res.status(502).send("Image proxy failed: " + err.message);
  });

  request.setTimeout(30000, () => {
    request.destroy();
    res.status(504).send("Image proxy timeout");
  });
});

// ─── Chat Route (Protected) ───────────────────────────────────────────────────
app.post("/chat", requireAuth, async (req, res) => {
  try {
    const { message, history, model, systemPrompt } = req.body;
    const apiKey = (process.env.GEMINI_API_KEY || "").trim();

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    if (!apiKey) {
      return res.status(400).json({
        error: "API Key is missing. Please set your GEMINI_API_KEY in the .env file in the project folder."
      });
    }

    // Base system instructions
    let activeSystemPrompt = systemPrompt ||
      "You are a helpful, friendly, and highly intelligent AI chatbot assistant. " +
      "Provide clear, accurate, and structured answers. Use markdown formatting when appropriate.";

    // Image generation instructions
    activeSystemPrompt += "\n\nIMPORTANT - Image Generation Instructions:\n" +
      "When the user asks you to create, generate, draw, paint, make, or visualize any image or picture, you MUST respond by embedding an image using this EXACT markdown format:\n" +
      "![brief description](https://image.pollinations.ai/prompt/YOUR_DETAILED_PROMPT_HERE?width=768&height=512&nologo=true)\n" +
      "Replace YOUR_DETAILED_PROMPT_HERE with a URL-encoded version of a detailed description of the image. For example, for 'draw a sunset over the ocean', return:\n" +
      "![sunset over ocean](https://image.pollinations.ai/prompt/beautiful%20golden%20sunset%20over%20calm%20ocean%20waves%2C%20vibrant%20orange%20sky%2C%20photorealistic?width=768&height=512&nologo=true)\n" +
      "ALWAYS include the markdown image tag. NEVER say you cannot generate images. After the image, add a brief description of what you created.";

    // Build chat history
    const chatHistory = (history || []).map(msg => ({
      role: msg.role === "assistant" || msg.role === "model" ? "model" : "user",
      parts: [{ text: msg.text }]
    }));

    const modelNames = model
      ? [model, ...FALLBACK_GEMINI_MODELS.filter(m => m !== model)]
      : FALLBACK_GEMINI_MODELS;

    const { reply, modelName } = await createChatResponse(apiKey, modelNames, activeSystemPrompt, chatHistory, message);
    console.log(`Using Gemini model: ${modelName}`);
    res.json({ reply, model: modelName });

  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Global Error Handler:", err);
  res.status(err.status || 500).json({ error: err.message || "Something went wrong." });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Chatbot server running on http://localhost:${PORT}`);
  console.log(`Login page: http://localhost:${PORT}/login`);
});