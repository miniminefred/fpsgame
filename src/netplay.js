import { RemotePlayer } from './remote-player.js';
import { EYE } from './metrics.js';

// Co-op: what actually crosses the wire, and who is allowed to decide what.
//
// `net.js` is the channel and knows nothing about the game. This is the other
// half: one message type per thing that can happen, and one rule underneath all
// of them.
//
// THE RULE. The floor is not sent — it is REBUILT. Every floor in this game is a
// pure function of one integer seed (see gen/rng.js), so the host rolls a seed,
// sends four bytes, and the joiner generates the same building down to which
// filing cabinet is in which corner and which of two hundred people is standing
// in it. That is what makes this affordable at all: everything below is a
// correction to a simulation the other end is already running, not a description
// of a world it has never seen.
//
// What follows from that:
//
//   * THE STAFF ARE THE HOST'S. Both browsers hold the same roster in the same
//     order, so a body's index in `enemies.items` is its name on the wire. The
//     host thinks for all of them and streams positions; the joiner poses its
//     copies and never runs the AI (`enemies.puppet`). Two browsers each running
//     the AI would not be one floor, it would be two — a shot fired at somebody
//     who, over there, is in the next room.
//   * DAMAGE IS THE HOST'S. The joiner's shots are real and immediate on its own
//     screen — the tracer, the flash, the flesh impact — but the health is the
//     host's, and the kill comes back as a message. See `hit` in enemies.js.
//   * DESTRUCTION IS SYMMETRIC. Either browser may shoot a desk apart, because
//     `_shatter` is idempotent and the thing either exists or it does not. That
//     one is worth syncing rather than leaving local, because destroying a prop
//     hands its tiles back to the nav grid — leave it out and the joiner watches
//     the staff walk through a cabinet that is still standing.
//   * CARDS ARE THE TEAM'S. One of you badging a door while the other stands in
//     front of it refusing to open is not a lock, it is a bug.
//
// WHAT IS NOT SYNCED, on purpose: ragdoll poses (each browser drops its own
// corpse), spent brass, bullet decals, debris, the gas out of an extinguisher and
// the arcs off the generator's wreck. All of it is cosmetic, all of it is
// hundreds of bodies a floor, and none of it changes what either player can do.
// A corpse lying at a slightly different angle in two browsers is not a bug worth
// a packet a frame.

// How often state goes out. Both are well under the frame rate on purpose —
// these are corrections to a running simulation, not the simulation.
//
// The player's own position is the more frequent of the two because it is what
// the other screen is looking straight at: a teammate walking is judged by eye,
// and interpolating between packets 8 times a second reads as a jog on ice
// however smooth the curve. The roster can afford less, because a body twenty
// metres down a corridor is a silhouette.
const POS_HZ = 20;
const SNAP_HZ = 12;

// Scratch for the enemy snapshot, allocated once. It is at most SNAP_CAP bodies
// long (see enemies.js) and refilled from the top every time.
const SNAP_MAX = 64 * 6;

export class NetPlay {
  constructor({ net, game, scene, menu }) {
    this.net = net;
    this.game = game;
    this.menu = menu;
    this.remote = new RemotePlayer(scene);

    this._posTimer = 0;
    this._snapTimer = 0;
    this._snap = new Array(SNAP_MAX);
    // Set while a message from the wire is being applied. Everything that
    // announces itself checks it, so replaying an event cannot announce the
    // replay back — which is otherwise an event that bounces between two
    // browsers for ever, and the reason this is a flag rather than a convention.
    this._replaying = false;
    // Set while the host is applying a joiner's hit report, so the death that
    // may come out of it is credited to the joiner rather than to the host.
    this._crediting = false;

    // The other player, in the shape `enemies.js` wants a target in: a position,
    // and something that happens when they are hurt. Rebuilt in place every
    // frame rather than allocated, because the roster reads it two hundred times
    // a frame.
    this._remoteTarget = {
      x: 0, y: 0, z: 0, layer: 0, dead: true, hidden: false,
      hurt: (amount, sx, sz) => {
        // Over there, not here. All this end can do is say so.
        this.send({ t: 'hu', a: Math.round(amount * 10) / 10, x: r2(sx), z: r2(sz) });
      },
    };

    // ...and the player at this keyboard, in the same shape. It exists so that
    // enemies.js has exactly one kind of thing to shoot at and never has to ask
    // which of the two it is dealing with.
    this._localTarget = {
      x: 0, y: 0, z: 0, layer: 0, dead: false, hidden: false,
      hurt: (amount, sx, sz) => {
        this.game.player.takeDamage(amount);
        this.game.hud.damage(Math.min(1, amount / 25), sx, sz);
      },
    };
    this._targets = [this._localTarget];

    this._wire();
  }

  get online() { return this.net.online; }
  get isHost() { return this.net.isHost; }

  /**
   * Whether the roster has to keep thinking even though the player at this
   * keyboard is dead. Only ever true on the host, and it is the difference
   * between a joiner playing on and a joiner watching two hundred statues.
   */
  get simulating() {
    return this.net.isHost && this.remote.fresh && this.remote.body.alive;
  }

  /** Who the staff are working against this frame. See enemies.js's `update`. */
  targets() {
    const p = this.game.player.object.position;
    const local = this._localTarget;
    local.x = p.x; local.y = p.y; local.z = p.z;
    local.dead = this.game.player.dead;
    local.hidden = this.game.player.hidden;

    if (!this.online || !this.remote.fresh) {
      if (this._targets.length !== 1) this._targets = [local];
      return this._targets;
    }

    const b = this.remote.body;
    const t = this._remoteTarget;
    t.x = b.x; t.y = b.y + EYE; t.z = b.z;
    t.dead = !b.alive;
    t.hidden = !!b.hidden;
    if (this._targets.length !== 2) this._targets = [local, t];
    return this._targets;
  }

  /** Bodies the doors should also open for. Empty outside a session. */
  others() {
    return this.online && this.remote.fresh && this.remote.body.alive
      ? [this.remote.body]
      : null;
  }

  send(msg) { return this.net.send(msg); }

  // --- the frame ---------------------------------------------------------------

  update(dt) {
    this.remote.update(dt, this.game.audio);
    if (!this.online) return;

    this._posTimer -= dt;
    if (this._posTimer <= 0) {
      this._posTimer = 1 / POS_HZ;
      this._sendPosition();
    }

    if (!this.net.isHost) return;
    this._snapTimer -= dt;
    if (this._snapTimer <= 0) {
      this._snapTimer = 1 / SNAP_HZ;
      const n = this.game.enemies.snapshot(this._snap, this.targets());
      // An empty snapshot is not sent. On a big floor with both players in a
      // quiet corner that is most of them.
      if (n > 0) this.send({ t: 'e', n: this.game.floor, a: this._snap.slice(0, n) });
    }
  }

  _sendPosition() {
    const g = this.game;
    const p = g.player.object.position;
    this.send({
      t: 'p',
      x: r2(p.x), y: r2(p.y - EYE), z: r2(p.z),   // feet, not eyes: it is a body over there
      r: r2(g.player.yaw),
      hp: Math.round(g.player.health),
      d: g.player.dead ? 1 : 0,
      // Unseen, and it rides beside `d` because it does the same job: it is the
      // other reason the roster over there must not be chasing this body.
      h: g.player.hidden ? 1 : 0,
      // Whether the gun is up. Not "did I fire this instant" — that arrives as
      // its own message — but "am I in a fight", which is what decides the pose.
      g: g.shooting.cooldown > 0 || g.shooting.keys.fire ? 1 : 0,
    });
  }

  // --- what this end announces --------------------------------------------------

  /** Every hook the game hands us. Called once, from the constructor. */
  _wire() {
    const g = this.game;

    this.net.onOpen = () => this._sessionUp();
    this.net.onClose = () => this._sessionDown();
    this.net.onMessage = (msg) => this._receive(msg);

    // A shot of ours, so the other screen sees the tracer and hears the gun.
    g.shooting.onShot = (from, to) => {
      if (!this.online) return;
      this.send({
        t: 's',
        ax: r2(from.x), ay: r2(from.y), az: r2(from.z),
        bx: r2(to.x), by: r2(to.y), bz: r2(to.z),
      });
    };

    // A shot of ours that landed on somebody, and we are not the one who decides
    // what that costs them.
    g.enemies.onReport = (e, damage, hit) => {
      if (!this.online || !e) return;
      this.send({
        t: 'r', n: g.floor, i: e.index, d: Math.round(damage * 10) / 10,
        ...(hit ? {
          dx: r3(hit.dir.x), dy: r3(hit.dir.y), dz: r3(hit.dir.z),
          px: r2(hit.point.x), py: r2(hit.point.y), pz: r2(hit.point.z),
          pu: r2(hit.punch ?? 1),
        } : {}),
      });
    };

    // ...and the other side of that: we ARE the authority and have just decided
    // somebody is hurt or dead.
    g.enemies.onDamaged = (e, outcome, hit) => {
      if (!this.online) return;
      if (outcome === 'kill') {
        this.send({
          t: 'ek', n: g.floor, i: e.index,
          // Whose kill it was. The joiner needs it for the hitmarker and for its
          // own score — its shots come back as 'hit' and never as a kill, so this
          // message is the only place it can be told it got one.
          k: this._crediting ? 1 : 0,
          ...(hit ? {
            dx: r3(hit.dir.x), dy: r3(hit.dir.y), dz: r3(hit.dir.z),
            px: r2(hit.point.x), py: r2(hit.point.y), pz: r2(hit.point.z),
            pu: r2(hit.punch ?? 1),
          } : {}),
        });
      } else if (!this._crediting) {
        // Only for damage the joiner did NOT cause: a shot fired over there has
        // already flashed and grunted on its way out.
        this.send({ t: 'eh', n: g.floor, i: e.index });
      }
    };

    // Somebody on the floor fired. The joiner's roster never runs `_shoot`, so
    // without this the staff kill it in silence with their arms by their sides.
    g.enemies.onFire = (e, muzzle, aim) => {
      if (!this.online) return;
      this.send({
        t: 'ef', n: g.floor, i: e.index,
        ax: r2(muzzle.x), ay: r2(muzzle.y), az: r2(muzzle.z),
        bx: r2(aim.x), by: r2(aim.y), bz: r2(aim.z),
      });
    };

    // Furniture. Symmetric — see the header.
    g.destruction.onShatter = (entry, dir, point) => this._sendBreak(0, entry.index, dir, point);
    g.destruction.onBreakProp = (dyn, dir, point) => this._sendBreak(1, dyn.index, dir, point);

    // A card off the carpet. The tier is the whole message — see remoteCollect.
    g.keycards.onCollect = (tier) => {
      if (this.online && !this._replaying) this.send({ t: 'c', tier });
    };
  }

  _sendBreak(kind, index, dir, point) {
    if (!this.online || this._replaying || index === undefined) return;
    this.send({
      t: 'b', n: this.game.floor, k: kind, i: index,
      dx: r3(dir.x), dy: r3(dir.y), dz: r3(dir.z),
      px: r2(point.x), py: r2(point.y), pz: r2(point.z),
    });
  }

  /**
   * A camera got its six seconds, or somebody walked through a laser.
   *
   * On the host this raises the alarm and tells the joiner who is coming. On the
   * joiner it does nothing locally and asks the host instead — and that is not
   * tidiness, it is the one thing that would break the roster: `enemies.alarm`
   * APPENDS four new bodies to `items`, and an index that means one man in one
   * browser and another man in the other is every message after it landing on the
   * wrong person.
   *
   * Returns whether it was handled here.
   */
  alarmFrom(x, z) {
    if (!this.online) return false;
    if (this.net.isHost) return false;
    this.send({ t: 'aq', x: r2(x), z: r2(z) });
    return true;
  }

  /** The host has raised one. Tell the joiner who turned up. */
  announceAlarm(response) {
    if (!this.online || !this.net.isHost) return;
    this.send({
      t: 'al', n: this.game.floor,
      list: response.spawned.map((e) => e.netSpawn).filter(Boolean),
      c: response.spawned.length + response.roused + response.heard,
    });
  }

  /** A new floor, or the first one. Host only. */
  announceFloor(floor, seed, fresh) {
    if (!this.online || !this.net.isHost) return;
    this.send({ t: fresh ? 'h' : 'f', f: floor, s: seed });
    this.remote.hide();
  }

  /**
   * We are standing on the exit pad.
   *
   * The host descends the team itself; the joiner asks. Either player reaching
   * the exit takes both of you down, which is the co-op reading of a floor being
   * finished — the alternative is standing on the pad waiting for somebody who is
   * still looting the third floor.
   *
   * Returns true if the descent is somebody else's to make.
   */
  requestDescend() {
    if (!this.online || this.net.isHost) return false;
    this.send({ t: 'x', n: this.game.floor });
    return true;
  }

  /** Clicked after dying. The run is the team's, so the restart is too. */
  requestRestart() {
    if (!this.online || this.net.isHost) return false;
    this.send({ t: 'rs' });
    return true;
  }

  // --- what the other end says --------------------------------------------------

  _receive(msg) {
    const g = this.game;

    // Anything that names an index — a body, a filing cabinet — is only meaningful
    // on the floor it was sent from, and says so with `n`. A packet that crossed a
    // descent refers to a roster that has been cleared away, and applying it would
    // land on whoever is now standing at that index in a completely different
    // building. The two messages that announce a floor carry `f` instead, and are
    // deliberately not stamped: they are what MAKES the floor current.
    if (msg.n !== undefined && msg.n !== g.floor) return;

    this._replaying = true;
    try { this._apply(msg, g); }
    catch (err) { console.warn('[netplay] failed to apply', msg?.t, err); }
    finally { this._replaying = false; }
  }

  _apply(msg, g) {
    switch (msg.t) {
      // --- the run --------------------------------------------------------
      case 'h':   // a fresh co-op run, on the host's seed
        g.startCoop(msg.s);
        this.remote.hide();
        break;
      case 'f':   // ...and every floor after it
        g.goToFloor(msg.f, msg.s);
        this.remote.hide();
        break;
      case 'x':   // the joiner is on the exit pad
        // Checked against our own roster rather than taken on trust: the two
        // agree about who is dead, so if this end still has hostiles up then the
        // message is stale — a descent that arrived a frame after a body did.
        if (g.enemies.hostileCount === 0) g.descend();
        break;
      case 'rs':
        g.startCoop();
        break;

      // --- the other player ----------------------------------------------
      case 'p':
        this.remote.apply({
          x: msg.x, y: msg.y, z: msg.z, yaw: msg.r,
          health: msg.hp, dead: !!msg.d, firing: !!msg.g, hidden: !!msg.h,
        });
        break;
      case 's': {
        // Their gun. Drawn from their muzzle to where their own raycast ended,
        // so it stops on the wall it stopped on over there.
        const from = { x: msg.ax, y: msg.ay, z: msg.az };
        g.effects.tracer(from, { x: msg.bx, y: msg.by, z: msg.bz });
        g.effects.muzzle(from, 1);
        g.audio.enemyShot(this.remote.body);
        break;
      }
      case 'hu':  // the staff over there hurt us
        g.player.takeDamage(msg.a);
        g.hud.damage(Math.min(1, msg.a / 25), msg.x, msg.z);
        break;

      // --- the staff ------------------------------------------------------
      case 'e':
        g.enemies.applySnapshot(msg.a);
        break;
      case 'eh': {
        const e = g.enemies.netHurt(msg.i);
        if (e) g.audio.enemyPain(e);
        break;
      }
      case 'ek': {
        const e = g.enemies.netDie(msg.i, hitOf(msg));
        if (!e) break;
        g.audio.enemyDeath(e);
        // Their kill, and the only place this end can learn it: a joiner's shots
        // come back from `hit` as 'hit' whatever they did.
        if (msg.k) { g.kills++; g.hud.hitmarker(true); g.audio.ping(true); }
        break;
      }
      case 'ef': {
        const e = g.enemies.items[msg.i];
        const from = { x: msg.ax, y: msg.ay, z: msg.az };
        g.effects.tracer(from, { x: msg.bx, y: msg.by, z: msg.bz });
        if (e) {
          g.effects.muzzle(from, e.type.scale);
          g.audio.enemyShot(e);
        }
        break;
      }
      case 'r': {
        // A hit report. Ours to decide, and the outcome goes back out through
        // `onDamaged` — which is why the credit flag is set around it rather
        // than passed down: `_damage` has no business knowing about the wire.
        const e = g.enemies.items[msg.i];
        if (!e?.alive) break;
        this._crediting = true;
        // Not `_replaying`: this is a decision, and its result has to be
        // announced. The two flags exist precisely because they are opposites.
        this._replaying = false;
        try { g.enemies._damage(e, msg.d, hitOf(msg)); }
        finally { this._crediting = false; this._replaying = true; }
        break;
      }
      case 'aq': {
        // The joiner's camera saw the joiner. The response is placed by walked
        // distance from whoever was seen, so it is placed from THEIR position.
        const response = g.enemies.alarm(msg.x, msg.z);
        g.applyAlarm(response);
        this.announceAlarm(response);
        break;
      }
      case 'al':
        g.shooting.addHittables(g.enemies.addResponders(msg.list));
        g.alarmSignal(msg.c ?? 0);
        break;

      // --- the floor ------------------------------------------------------
      case 'b': {
        const dir = { x: msg.dx, y: msg.dy, z: msg.dz };
        const at = { x: msg.px, y: msg.py, z: msg.pz };
        if (msg.k) g.destruction.netBreakProp(msg.i, dir, at);
        else g.destruction.netShatter(msg.i, dir, at);
        break;
      }
      case 'c':
        g.keycards.remoteCollect(msg.tier);
        break;
    }
  }

  // --- the session ---------------------------------------------------------------

  _sessionUp() {
    const g = this.game;
    this.remote.hide();
    this.remote.revive();

    // Authority is decided here and nowhere else, and it is the one line that
    // makes the whole file work: exactly one of the two browsers thinks for the
    // staff, and the other one poses them.
    g.enemies.authority = this.net.isHost;
    g.enemies.puppet = !this.net.isHost;

    this.menu?.close();

    if (this.net.isHost) {
      // A fresh run on both machines. Joining mid-floor is not attempted, and
      // that is a deliberate simplification rather than a gap: a floor half
      // fought through has two hundred healths, a scattering of shattered
      // furniture and a wallet in it, and sending all of that to bring one
      // browser up to date is a great deal of protocol for the one moment in a
      // session it would ever be used.
      g.startCoop();
      g.hud.message('CO-OP — SOMEBODY JOINED YOU', 2400,
        { text: 'NEW RUN FROM FLOOR 1', ms: 2000 });
    } else {
      g.hud.message('CO-OP — CONNECTED', 2000,
        { text: 'WAITING FOR THE HOST’S FLOOR', ms: 2000 });
    }
  }

  _sessionDown() {
    const g = this.game;
    // Back to a game that decides things for itself. Without this the joiner is
    // left holding a roster it will never be told anything about again — two
    // hundred people standing still, and nothing it shoots ever dies.
    g.enemies.authority = true;
    g.enemies.puppet = false;
    this.remote.hide();
    this.menu?.refresh();

    if (g.state === 'playing') {
      g.hud.message('CO-OP ENDED — ON YOUR OWN', 2600);
    }
  }
}

// The shot that did it, rebuilt from the wire. It exists to throw a ragdoll, so
// a missing one is not a failure — `ragdolls.js` takes null and lets the body
// fold where it stood.
function hitOf(msg) {
  if (msg.dx === undefined) return null;
  return {
    dir: { x: msg.dx, y: msg.dy, z: msg.dz },
    point: { x: msg.px, y: msg.py, z: msg.pz },
    punch: msg.pu ?? 1,
  };
}

// Positions to the centimetre and directions to the thousandth. Both are far
// below anything visible on a body twenty metres away, and rounding is most of
// what keeps a packet small — an unrounded float is seventeen characters.
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
