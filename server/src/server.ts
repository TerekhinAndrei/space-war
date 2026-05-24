// SPACE WAR multiplayer — PartyKit room handler.
//
// Phase 0c: lobby connection. The room handles the socket lifecycle
// and lets each connection register a callsign + colour, so the client
// can show a readable pilot list instead of raw connection ids.
// Game simulation arrives in Phase 2.

import type * as Party from "partykit/server";

interface PingMessage {
  t: "PING";
  clientSent: number;
}

interface JoinMessage {
  t: "JOIN";
  callsign: string;
  color?: string;
}

type ClientMessage = PingMessage | JoinMessage | { t: string; [k: string]: unknown };

interface PeerProfile {
  id: string;
  callsign: string;
  color: string;
}

// Per-connection state stored on the WebSocket itself (PartyKit
// persists this across the message handler instances on the room).
type ConnState = { callsign: string; color: string };

const FALLBACK_COLORS = ["#00ff66", "#66aaff", "#ffaa44", "#ff66cc"];
const sanitizeCallsign = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw : "";
  const cleaned = s.replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 16);
  return cleaned || "PILOT";
};
const sanitizeColor = (raw: unknown, fallback: string): string => {
  return typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
};

export default class SpaceWarRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  // Snapshot every connection currently in the room as a profile list.
  private peers(): PeerProfile[] {
    const out: PeerProfile[] = [];
    for (const c of this.room.getConnections<ConnState>()) {
      const s = c.state;
      out.push({
        id: c.id,
        callsign: s?.callsign ?? "PILOT",
        color: s?.color ?? FALLBACK_COLORS[0],
      });
    }
    return out;
  }

  onConnect(conn: Party.Connection<ConnState>, _ctx: Party.ConnectionContext) {
    // Default profile before the client sends JOIN — keeps the list
    // sane if the socket disconnects mid-handshake.
    const fallbackColor = FALLBACK_COLORS[this.peers().length % FALLBACK_COLORS.length];
    conn.setState({ callsign: "PILOT", color: fallbackColor });
    conn.send(
      JSON.stringify({
        t: "WELCOME",
        id: conn.id,
        room: this.room.id,
        serverNow: Date.now(),
        peers: this.peers(),
      })
    );
    console.log(`[${this.room.id}] socket open ${conn.id} (${this.peers().length} in room)`);
  }

  onMessage(message: string, sender: Party.Connection<ConnState>) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }
    if (msg.t === "PING") {
      sender.send(
        JSON.stringify({
          t: "PONG",
          clientSent: (msg as PingMessage).clientSent,
          serverNow: Date.now(),
        })
      );
      return;
    }
    if (msg.t === "JOIN") {
      const j = msg as JoinMessage;
      const callsign = sanitizeCallsign(j.callsign);
      const color = sanitizeColor(
        j.color,
        sender.state?.color ?? FALLBACK_COLORS[0]
      );
      sender.setState({ callsign, color });
      // Broadcast the up-to-date peer list to everyone so each client
      // sees the new pilot. Cheap with at most 4 connections per room.
      this.room.broadcast(
        JSON.stringify({ t: "PEERS", peers: this.peers() })
      );
      console.log(`[${this.room.id}] ${sender.id} → ${callsign}`);
    }
  }

  onClose(conn: Party.Connection<ConnState>) {
    this.room.broadcast(
      JSON.stringify({ t: "PEERS", peers: this.peers() })
    );
    console.log(`[${this.room.id}] socket close ${conn.id}`);
  }
}

SpaceWarRoom satisfies Party.Worker;
