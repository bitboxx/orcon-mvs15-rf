// Dry the bathroom out after a shower. Two sensors ask for the fan:
//   shower-cabin, a sensor inside the shower cabin  (zigbee2mqtt/shower-cabin)
//   bathroom, a sensor in the room outside it        (zigbee2mqtt/bathroom)
// Either can start a cycle. The cycle only ends when BOTH are satisfied, or when
// drying stops making progress, or on the backstop.
//
// High is held by re-issuing a 30 minute timed boost (22F3) every 25 minutes. The
// overlap is the safety net: if node-red dies, the flow is redeployed, or both
// sensors go flat, the boost in flight expires by itself within half an hour and
// the fan returns to the last chosen stand. Keep that on auto.
//
// Progress is judged on ABSOLUTE humidity, never relative. Ventilating with cooler
// air drops the room temperature, and falling temperature pushes RH up even while
// moisture is leaving. Measured: 25 minutes on high took the cabin from 21.2
// to 20.8 g/m3 while RH rose from 92 to 93.
//
// Frames impersonate the wall remote 29:222222. Substitute your own addresses.
// Payload reference: the README in this repo.

const CABIN_ON  = 80, CABIN_OFF = 75;   // % RH, shower-cabin
const BATH_ON   = 60, BATH_OFF  = 55;   // % RH, bathroom
const REISSUE   = 25;    // minutes between boost renewals, must stay under BOOST
const BOOST     = 30;    // minutes per 22F3, the safety net
const STAND     = 2;     // stand the boost holds, 3 is high and 2 is medium. A 22F3 with
                         // a stand byte of 02 was confirmed on the fan (31D9 -> 000002),
                         // even though the remote has no button that produces one.
const MAX_MINS  = 480;   // backstop only, the plateau is the real stop
const PLATEAU   = 45;    // no improvement in this long means as dry as it gets
const STEP_G    = 0.3;   // g/m3 that counts as progress
const NEW_EVENT = 1.0;   // g/m3 rise after a stop that means a fresh shower
const STALE_MIN = 90;    // ignore a sensor that has not reported in this long

const TX  = "RAMSES/GATEWAY/18:333333/tx";
const FAN = "I --- 29:222222 29:111111 --:------ ";
const hex2 = n => ("0" + n.toString(16).toUpperCase()).slice(-2);
const boostMsg = () => ({ topic: TX, payload: { msg: FAN + "22F3 007 0012" + hex2(BOOST) + hex2(STAND) + "040404" } });
const autoMsg  = () => ({ topic: TX, payload: { msg: FAN + "22F1 003 000404" } });
const absHum = (t, rh) => 216.7 * (rh / 100 * 6.112 * Math.exp(17.62 * t / (243.12 + t)) / (273.15 + t));

// ---- record whichever sensor just spoke ----
const p = msg.payload;
if (!p || typeof p.humidity !== "number" || typeof p.temperature !== "number") { return null; }
const now = Date.now();
const which = String(msg.topic).endsWith("bathroom") ? "bath" : "cabin";
flow.set(which, { h: p.humidity, t: p.temperature, g: absHum(p.temperature, p.humidity), at: now });

const cabin = flow.get("cabin");
const bath  = flow.get("bath");
const fresh = r => r && (now - r.at) / 60000 < STALE_MIN;

// The wetness of the room as a whole is whichever sensor is worst. Progress means
// that one improving; drying the cabin while the bathroom climbs is not progress.
const parts = [fresh(cabin) ? cabin.g : null, fresh(bath) ? bath.g : null].filter(v => v !== null);
if (!parts.length) { return null; }
const metric = Math.max(...parts);

const wants = (fresh(cabin) && cabin.h > CABIN_ON) || (fresh(bath) && bath.h > BATH_ON);
const satisfied = (!fresh(cabin) || cabin.h < CABIN_OFF) && (!fresh(bath) || bath.h < BATH_OFF);
const label = () => (fresh(cabin) ? "cabin " + cabin.h + "%" : "cabin -") +
                    ", " + (fresh(bath) ? "bath " + bath.h + "%" : "bath -") +
                    " (" + metric.toFixed(1) + " g/m3)";

let s = flow.get("vent");
if (s === undefined) {
    // First reading after a deploy or restart. Adopt the current condition rather
    // than acting on it. Context here is memory-only, so this runs often.
    flow.set("vent", { drying: false, since: 0, lastSent: 0, best: metric, bestAt: now, stoppedAt: metric });
    node.status({ fill: "blue", shape: "ring", text: "start " + label() });
    return null;
}
const mins = ms => Math.round((now - ms) / 60000);

// ---- idle ----
if (!s.drying) {
    // After a stop, wait for the room to genuinely dry out, or for a fresh moisture
    // event. A shower shows up as absolute humidity rising again; the stale damp we
    // just gave up on does not. Without this the trigger undoes the plateau stop on
    // the very next reading, which is what happened on 4-5 Sep.
    if (s.stoppedAt !== undefined) {
        if (satisfied || metric > s.stoppedAt + NEW_EVENT) {
            delete s.stoppedAt; flow.set("vent", s);
        } else {
            node.status({ fill: "grey", shape: "ring", text: label() + " holding" });
            return null;
        }
    }
    if (wants) {
        flow.set("vent", { drying: true, since: now, lastSent: now, best: metric, bestAt: now });
        node.status({ fill: "red", shape: "dot", text: "drying, " + label() });
        node.warn("drying started: " + label());
        return boostMsg();
    }
    node.status({ fill: "grey", shape: "ring", text: label() });
    return null;
}

// ---- drying ----
if (satisfied) {
    flow.set("vent", { drying: false, since: 0, lastSent: 0, best: metric, bestAt: now });
    node.status({ fill: "green", shape: "ring", text: "dry, " + mins(s.since) + " min" });
    node.warn("dry after " + mins(s.since) + " minutes: " + label() + ", back to auto");
    return autoMsg();
}

if (metric < s.best - STEP_G) { s.best = metric; s.bestAt = now; }

if (mins(s.since) >= MAX_MINS || mins(s.bestAt) >= PLATEAU) {
    let why = mins(s.since) >= MAX_MINS ? "time limit" : "stopped drying further";
    // Measured 6 Sep 2026: a shower with the cabin door left open dried at
    // 1.9 g/m3 per hour, the same shower with it closed managed 0.26 and gave up
    // after 46 minutes. A cabin still wet while the bathroom next to it stays dry
    // is that signature: moisture cannot leave the cabin, so the door is shut.
    // Nothing at the fan can fix it, which is why it is worth saying out loud.
    if (fresh(cabin) && fresh(bath) && cabin.h > CABIN_ON && bath.h < BATH_ON) {
        why += ", cabin door looks closed";
    }
    flow.set("vent", { drying: false, since: 0, lastSent: 0, best: metric, bestAt: now, stoppedAt: metric });
    node.status({ fill: "yellow", shape: "dot", text: "stopped, " + label() });
    node.warn("done after " + mins(s.since) + " minutes (" + why + "): " + label() + ", back to auto");
    return autoMsg();
}

if (mins(s.lastSent) >= REISSUE) {
    s.lastSent = now; flow.set("vent", s);
    node.status({ fill: "red", shape: "dot", text: "drying " + mins(s.since) + " min, " + label() });
    node.warn("boost renewed, " + mins(s.since) + " min: " + label());
    return boostMsg();
}

flow.set("vent", s);
node.status({ fill: "red", shape: "ring", text: mins(s.since) + " min, " + label() });
return null;
