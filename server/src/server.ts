// SPACE WAR multiplayer — PartyKit room handler.
//
// Phase 0: hello-world. The room logs joins/leaves and echoes whatever
// messages arrive, with a server timestamp attached so the client can
// measure round-trip latency. No game simulation yet — that lands in
// Phase 2.
//
// Each PartyKit "party" is a Durable-Object-backed room with a stable
// id (the URL path), one in-memory instance per room. Clients connect
// over WebSocket; `onConnect` is fired once per socket, `onMessage`
// for every frame received.

import type * as Party from "partykit/server";

interface PingMessage {
  t: "PING";
  clientSent: number;
}

type ClientMessage = PingMessage | { t: string; [k: string]: unknown };

export default class SpaceWarRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  // Send a welcome packet so the client can confirm the connection is
  // live and see how many other peers are in the room already.
  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const peers = [...this.room.getConnections()].map((c) => c.id);
    conn.send(
      JSON.stringify({
        t: "WELCOME",
        id: conn.id,
        room: this.room.id,
        serverNow: Date.now(),
        peers,
      })
    );
    // Tell everyone else a new peer joined.
    this.room.broadcast(
      JSON.stringify({ t: "PEER_JOIN", id: conn.id }),
      [conn.id]
    );
    console.log(`[${this.room.id}] joined ${conn.id} (${peers.length + 1} in room)`);
  }

  onMessage(message: string, sender: Party.Connection) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(message) as ClientMessage;
    } catch {
      return; // ignore non-JSON noise
    }
    if (msg.t === "PING") {
      // Echo a PONG carrying the client's original send time plus the
      // server's now — lets the client compute RTT and a clock offset.
      sender.send(
        JSON.stringify({
          t: "PONG",
          clientSent: (msg as PingMessage).clientSent,
          serverNow: Date.now(),
        })
      );
      return;
    }
    // Unknown message type — drop it silently for now.
  }

  onClose(conn: Party.Connection) {
    this.room.broadcast(JSON.stringify({ t: "PEER_LEAVE", id: conn.id }));
    console.log(`[${this.room.id}] left ${conn.id}`);
  }
}

SpaceWarRoom satisfies Party.Worker;
