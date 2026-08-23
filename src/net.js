import Peer from 'peerjs';

// Two browsers, one floor.
//
// This file is ONLY the wire: a code you can read out loud, a peer-to-peer data
// channel that ends up carrying it, and a message pump. It knows nothing about
// the game — no enemy indices, no floor seeds, no protocol semantics. All of
// that lives in `netplay.js`, which is the half that has opinions.
//
// The split matters because the two fail in completely different ways. A
// connection fails outside our control (a signalling server refusing an id, a
// NAT that will not hole-punch, a phone going to sleep) and the only correct
// response is to say so on screen. A protocol fails because we got the game
// wrong, and the only correct response is to fix it. Keeping them in one file
// means every network bug reads as ambiguous between the two.
//
// WHY A THIRD PARTY. WebRTC cannot introduce two browsers to each other: each
// one has to hear the other's connection candidates before any packet can flow,
// and hearing them needs a server both can already reach. We do not have one and
// cannot host one from a static GitHub Pages site, so this uses PeerJS's free
// public broker. Only the code below and the WebRTC handshake ever reach it —
// once the channel is up, every byte of game state goes browser to browser and
// touches nothing else. That is worth knowing because it is also the weakest
// link: the broker is rate-limited and occasionally down, and there is no
// fallback. `onStatus` exists so that shows up as a message rather than as a
// menu that quietly does nothing.

// The alphabet a code is drawn from, and it is a legibility decision rather
// than an entropy one: these are read off one screen and typed into another,
// often out loud over a voice call. I/1, O/0 and 5/S are the pairs that get
// misheard and mistyped, so none of them is in here. 32 symbols over 6 places
// is 2^30 codes, which is far more than enough for a broker that will not host
// more than a handful of games at a time anyway.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

// Every id on the public broker shares one namespace with every other app using
// it, so a bare six-character code would collide with strangers. The prefix is
// what makes 'QK7RMP' ours.
const PREFIX = 'officedescent-';

// How long to wait for the broker before admitting it is not coming. Hosting
// only needs the broker to answer; joining also needs the peer to accept, and a
// code typed one character wrong looks exactly like a peer that is not there —
// so the join timeout is the one that has to produce a legible message.
const OPEN_TIMEOUT = 12000;
const JOIN_TIMEOUT = 20000;

export function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/**
 * Normalises whatever the player typed into a code we can dial.
 *
 * Forgiving about presentation and strict about content, and the line between
 * the two is the point. Lower case is upper-cased and spaces, dashes and dots
 * are dropped, because people read six characters out in twos and threes and
 * type them back the same way — none of that changes which game is meant.
 *
 * What it deliberately does NOT do is guess at a character the alphabet above
 * never issues. Mapping a typed O onto Q would be inventing a code the player
 * did not give us, and the failure that produces is the worst one available:
 * dialling a stranger, or reporting "nobody is waiting" for a code that was
 * only mistyped. A character we cannot have printed is a mistake worth saying
 * out loud, so it survives to fail the check in `join`.
 */
export function normaliseCode(text) {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[\s\-_.,]/g, '')
    .slice(0, CODE_LEN);
}

/** Whether a normalised code is one we could have issued. */
export function validCode(code) {
  return code.length === CODE_LEN
    && [...code].every((ch) => ALPHABET.includes(ch));
}

export class Net {
  constructor() {
    // 'off' | 'hosting' | 'joining' | 'connected' | 'error'
    //
    // 'hosting' is a waiting room and 'joining' is a dial in progress; both go
    // to 'connected' from the same place (`_attach`), which is what keeps the
    // two roles from drifting apart in the states that follow.
    this.state = 'off';
    this.role = null;         // 'host' | 'client' | null
    this.code = null;         // the code the host published, either side
    this.error = null;

    this.peer = null;
    this.conn = null;

    // (state, detail) => void — the menu's only view of any of this.
    this.onStatus = null;
    // (msg) => void — one inbound game message. Set by netplay.js.
    this.onMessage = null;
    // () => void, () => void — the channel came up, and the channel went away.
    this.onOpen = null;
    this.onClose = null;

    this._timer = 0;
    // Set while we are tearing down on purpose, so the 'close' that teardown
    // provokes does not come back through as a dropped connection.
    this._closing = false;
  }

  get online() { return this.state === 'connected'; }
  get isHost() { return this.online && this.role === 'host'; }
  get isClient() { return this.online && this.role === 'client'; }

  /** Open a game and publish a code for it. */
  host() {
    this.leave();
    this.role = 'host';
    this._start(randomCode(), 0);
  }

  /** Dial a code somebody read out to us. */
  join(rawCode) {
    const code = normaliseCode(rawCode);
    if (!validCode(code)) {
      this._fail(code.length === CODE_LEN
        ? 'That is not a code we hand out — check it character by character'
        : `A code is ${CODE_LEN} characters — that one is ${code.length}`);
      return;
    }
    this.leave();
    this.role = 'client';
    this.code = code;
    this._set('joining');

    // The joiner takes a broker-assigned id rather than one of ours. Asking for
    // a name we do not need is one more way to be refused.
    this.peer = new Peer(undefined, { debug: 0 });
    this._wirePeer();
    this._timer = setTimeout(() => this._fail('The broker did not answer — try again'),
      OPEN_TIMEOUT);

    this.peer.on('open', () => {
      clearTimeout(this._timer);
      this._timer = setTimeout(
        () => this._fail(`Nobody answered on ${code} — check the code and that they are still waiting`),
        JOIN_TIMEOUT);
      this._attach(this.peer.connect(PREFIX + code, { reliable: true }));
    });
  }

  /**
   * Claim `code` on the broker and wait there.
   *
   * `attempt` exists because a code can be taken — by the vanishingly unlikely
   * collision, and much more often by our own previous session: the broker holds
   * an id for a while after the tab that owned it went away, so hosting twice in
   * a row is the case that actually hits this. Rerolling is the right answer to
   * both, and it is bounded because a broker that refuses three fresh codes is
   * not having an id problem.
   */
  _start(code, attempt) {
    this.code = code;
    this._set('hosting');

    this.peer = new Peer(PREFIX + code, { debug: 0 });
    this._wirePeer(() => {
      if (attempt >= 3) return false;
      this._destroyPeer();
      this._start(randomCode(), attempt + 1);
      return true;
    });

    this._timer = setTimeout(() => this._fail('The broker did not answer — try again'),
      OPEN_TIMEOUT);
    this.peer.on('open', () => {
      clearTimeout(this._timer);
      // Nothing else to do: the code is live and `connection` below is what
      // happens when somebody dials it.
      this._set('hosting');
    });
    this.peer.on('connection', (conn) => {
      // First one in gets the game. A second dialler is refused rather than
      // silently replacing the player already in the building.
      if (this.conn) { conn.close(); return; }
      this._attach(conn);
    });
  }

  _wirePeer(onIdTaken = null) {
    this.peer.on('error', (err) => {
      if (this._closing) return;
      if (err?.type === 'unavailable-id' && onIdTaken?.()) return;
      this._fail(describe(err));
    });
    // The broker drops idle sockets, and a tab waiting to be joined is idle by
    // definition — worse, a BACKGROUNDED tab has its timers throttled to about
    // one a minute, so the keepalive that would have held the socket open never
    // fires. Somebody who opens the panel, reads their code out and switches to
    // a chat window to send it is therefore the ordinary case, not an edge one.
    //
    // So this reconnects rather than failing. It is safe after the channel is up
    // too, and pointless: the data channel is browser-to-browser from there on
    // and the broker is not in it any more.
    this.peer.on('disconnected', () => {
      if (this._closing || this.state === 'connected') return;
      try { this.peer?.reconnect(); }
      catch { this._fail('Lost the broker before anyone connected'); }
    });
  }

  _attach(conn) {
    this.conn = conn;

    conn.on('open', () => {
      clearTimeout(this._timer);
      this._set('connected');
      this.onOpen?.();
    });
    conn.on('data', (msg) => {
      // Inbound data is the one place a peer's bug can become our crash, and
      // this is a game rather than a service: a malformed message must cost a
      // console line and nothing else.
      try { if (msg && typeof msg === 'object') this.onMessage?.(msg); }
      catch (err) { console.warn('[net] bad message', msg, err); }
    });
    conn.on('close', () => {
      if (this._closing) return;
      this.conn = null;
      this.error = 'The other player disconnected';
      this._set('error', this.error);
      this.onClose?.();
    });
    conn.on('error', (err) => {
      if (this._closing) return;
      this._fail(describe(err));
    });
  }

  /**
   * Post a message. Returns whether it went.
   *
   * Every caller in netplay.js fires and forgets, on purpose: a send that fails
   * because the channel just went away is not an error worth handling twice —
   * the 'close' handler above is already turning that into a status the player
   * can see.
   */
  send(msg) {
    if (!this.conn?.open) return false;
    try { this.conn.send(msg); return true; }
    catch { return false; }
  }

  /** Hang up, whatever we were doing. Safe to call from any state. */
  leave() {
    const wasOnline = this.state === 'connected';
    this._closing = true;
    clearTimeout(this._timer);
    try { this.conn?.close(); } catch { /* already gone */ }
    this.conn = null;
    this._destroyPeer();
    this._closing = false;

    this.role = null;
    this.code = null;
    this.error = null;
    this._set('off');
    if (wasOnline) this.onClose?.();
  }

  _destroyPeer() {
    try { this.peer?.destroy(); } catch { /* already gone */ }
    this.peer = null;
  }

  _fail(message) {
    clearTimeout(this._timer);
    this.error = message;
    // The peer goes but the code stays readable, so an error while hosting can
    // still say which code failed.
    this._closing = true;
    try { this.conn?.close(); } catch { /* already gone */ }
    this.conn = null;
    this._destroyPeer();
    this._closing = false;
    this._set('error', message);
  }

  _set(state, detail = null) {
    this.state = state;
    this.onStatus?.(state, detail);
  }
}

// PeerJS reports failures as a type plus a browser message, and neither on its
// own is much use to a player. These are the ones that actually turn up.
function describe(err) {
  switch (err?.type) {
    case 'peer-unavailable': return 'No game is waiting on that code';
    case 'unavailable-id':   return 'That code is taken — try hosting again';
    case 'network':          return 'Cannot reach the broker — check the connection';
    case 'browser-incompatible': return 'This browser cannot do peer-to-peer';
    case 'webrtc':           return 'The connection failed — a firewall may be blocking it';
    case 'server-error':     return 'The broker is having a bad day — try again shortly';
    default: return err?.message || 'Connection failed';
  }
}
