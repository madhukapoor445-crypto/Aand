import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import multer from "multer";
import sharp from "sharp";
import { storage } from "./storage";
import { insertUserSchema, insertItemSchema, insertMessageSchema, insertNotificationSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { z } from "zod";
import path from "path";
import fs from "fs";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = allowedTypes.test(file.mimetype);
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed"));
  },
});

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

function requireAuth(req: any, res: any, next: any) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  const clients = new Map<string, WebSocket>();

  wss.on("connection", (ws: WebSocket, req: any) => {
    let userId: string | null = null;

    ws.on("message", async (data: string) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === "auth") {
          userId = message.userId;
          if (userId) {
            clients.set(userId, ws);
          }
        } else if (message.type === "message" && userId) {
          const newMessage = await storage.createMessage({
            senderId: userId,
            receiverId: message.receiverId,
            itemId: message.itemId || null,
            content: message.content,
          });

          const receiverWs = clients.get(message.receiverId);
          if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({
              type: "new_message",
              message: newMessage,
            }));
          }

          ws.send(JSON.stringify({
            type: "message_sent",
            message: newMessage,
          }));

          await storage.createNotification({
            userId: message.receiverId,
            type: "message",
            title: "New Message",
            message: `You have a new message`,
            itemId: message.itemId || null,
            read: false,
          });
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    });

    ws.on("close", () => {
      if (userId) {
        clients.delete(userId);
      }
    });
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const validation = insertUserSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: fromError(validation.error).toString() });
      }

      const existingUser = await storage.getUserByEmail(validation.data.email);
      if (existingUser) {
        return res.status(400).json({ error: "Email already registered" });
      }

      const user = await storage.createUser(validation.data);
      req.session.userId = user.id;
      
      res.json({
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        classYear: user.classYear,
      });
    } catch (error: any) {
      console.error("Registration error:", error);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const loginSchema = z.object({
        email: z.string().email(),
        password: z.string().min(1),
      });
      
      const validation = loginSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: fromError(validation.error).toString() });
      }
      
      const { email, password } = validation.data;

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const valid = await storage.verifyPassword(user, password);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      req.session.userId = user.id;
      
      res.json({
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        classYear: user.classYear,
      });
    } catch (error: any) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", async (req, res) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUser(req.session.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      classYear: user.classYear,
    });
  });

  app.get("/api/items/recent", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
      const items = await storage.getRecentItems(limit);
      res.json(items);
    } catch (error: any) {
      console.error("Error fetching recent items:", error);
      res.status(500).json({ error: "Failed to fetch items" });
    }
  });

  app.get("/api/items/similar/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 3;
      const items = await storage.getSimilarItems(id, limit);
      res.json(items);
    } catch (error: any) {
      console.error("Error fetching similar items:", error);
      res.status(500).json({ error: "Failed to fetch similar items" });
    }
  });

  app.get("/api/items/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const item = await storage.getItem(id);
      
      if (!item) {
        return res.status(404).json({ error: "Item not found" });
      }
      
      res.json(item);
    } catch (error: any) {
      console.error("Error fetching item:", error);
      res.status(500).json({ error: "Failed to fetch item" });
    }
  });

  app.get("/api/items", async (req, res) => {
    try {
      const filters: any = {};
      
      if (req.query.category) {
        filters.category = req.query.category as string;
      }
      if (req.query.condition) {
        filters.condition = req.query.condition as string;
      }
      if (req.query.status) {
        filters.status = req.query.status as string;
      }
      
      const items = await storage.getItems(filters);
      res.json(items);
    } catch (error: any) {
      console.error("Error fetching items:", error);
      res.status(500).json({ error: "Failed to fetch items" });
    }
  });

  app.post("/api/items", requireAuth, upload.single("image"), async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      let imageUrl = "";
      if (req.file) {
        const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`;
        const filepath = path.join(uploadsDir, filename);
        
        if (ext === '.png') {
          await sharp(req.file.buffer)
            .resize(800, 800, { fit: "inside", withoutEnlargement: true })
            .png({ quality: 85 })
            .toFile(filepath);
        } else {
          await sharp(req.file.buffer)
            .resize(800, 800, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toFile(filepath);
        }
        
        imageUrl = `/uploads/${filename}`;
      }

      const itemData = {
        name: req.body.name,
        category: req.body.category,
        condition: req.body.condition,
        price: parseInt(req.body.price),
        description: req.body.description || null,
        negotiable: req.body.negotiable === "true",
        imageUrl: imageUrl || null,
        sellerId: userId,
        sellerClassYear: user.classYear,
      };

      const validation = insertItemSchema.safeParse(itemData);
      if (!validation.success) {
        return res.status(400).json({ error: fromError(validation.error).toString() });
      }

      const item = await storage.createItem(validation.data);
      res.json(item);
    } catch (error: any) {
      console.error("Error creating item:", error);
      res.status(500).json({ error: "Failed to create item" });
    }
  });

  app.patch("/api/items/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.session.userId!;
      
      const item = await storage.getItem(id);
      if (!item) {
        return res.status(404).json({ error: "Item not found" });
      }
      
      if (item.sellerId !== userId) {
        return res.status(403).json({ error: "Not authorized to update this item" });
      }

      const updates: Partial<typeof item> = {};
      if (req.body.name) updates.name = req.body.name;
      if (req.body.price) updates.price = parseInt(req.body.price);
      if (req.body.description !== undefined) updates.description = req.body.description;
      if (req.body.status) updates.status = req.body.status;
      if (req.body.negotiable !== undefined) updates.negotiable = req.body.negotiable;

      const updatedItem = await storage.updateItem(id, updates);
      res.json(updatedItem);
    } catch (error: any) {
      console.error("Error updating item:", error);
      res.status(500).json({ error: "Failed to update item" });
    }
  });

  app.delete("/api/items/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.session.userId!;
      
      const item = await storage.getItem(id);
      if (!item) {
        return res.status(404).json({ error: "Item not found" });
      }
      
      if (item.sellerId !== userId) {
        return res.status(403).json({ error: "Not authorized to delete this item" });
      }

      const success = await storage.deleteItem(id);
      res.json({ success });
    } catch (error: any) {
      console.error("Error deleting item:", error);
      res.status(500).json({ error: "Failed to delete item" });
    }
  });

  app.get("/api/messages/:userId", requireAuth, async (req, res) => {
    try {
      const currentUserId = req.session.userId!;
      const { userId } = req.params;
      
      const messages = await storage.getMessages(currentUserId, userId);
      res.json(messages);
    } catch (error: any) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  app.post("/api/messages/:id/read", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const success = await storage.markMessageAsRead(id);
      res.json({ success });
    } catch (error: any) {
      console.error("Error marking message as read:", error);
      res.status(500).json({ error: "Failed to mark message as read" });
    }
  });

  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const notifications = await storage.getNotifications(userId);
      res.json(notifications);
    } catch (error: any) {
      console.error("Error fetching notifications:", error);
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  });

  app.post("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const success = await storage.markNotificationAsRead(id);
      res.json({ success });
    } catch (error: any) {
      console.error("Error marking notification as read:", error);
      res.status(500).json({ error: "Failed to mark notification as read" });
    }
  });

  app.post("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const success = await storage.markAllNotificationsAsRead(userId);
      res.json({ success });
    } catch (error: any) {
      console.error("Error marking all notifications as read:", error);
      res.status(500).json({ error: "Failed to mark all notifications as read" });
    }
  });

  app.use("/uploads", (req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  });
  
  const express = await import("express");
  app.use("/uploads", express.default.static(uploadsDir));

  return httpServer;
}
