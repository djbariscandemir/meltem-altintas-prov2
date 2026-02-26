/**
 * Parse API Server - Production architecture.
 * POST /parse-listing: Mark listing as priority for immediate worker processing.
 * Worker runs independently; this endpoint only flags listings.
 */

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

/**
 * POST /parse-listing
 * Body: { listing_id: string }
 * Marks listing priority=true so worker picks it up immediately.
 */
app.post("/parse-listing", async (req, res) => {
  try {
    const { listing_id } = req.body;

    if (!listing_id) {
      return res.status(400).json({ error: "listing_id is required" });
    }

    if (!supabase) {
      return res.status(500).json({
        error: "Supabase not configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)",
      });
    }

    const { data, error } = await supabase
      .from("listings")
      .update({
        priority: true,
        parse_status: "pending",
      })
      .eq("id", String(listing_id).trim())
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[parse-server] update error:", error.message);
      return res.status(500).json({ error: "Failed to mark listing for parse" });
    }

    if (!data) {
      return res.status(404).json({ error: "Listing not found" });
    }

    res.json({ success: true, listing_id: data.id });
  } catch (err) {
    console.error("[parse-server] /parse-listing error:", err.message);
    res.status(500).json({ error: "Parse server error" });
  }
});

const PORT = process.env.PARSE_SERVER_PORT || 4000;
app.listen(PORT, () => {
  console.log(`Parse server running on port ${PORT}`);
});
