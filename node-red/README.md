# The drying flow

Dries a bathroom out after a shower and then stops, using two zigbee temperature and humidity
sensors and the `22F3` timed boost from the main [README](../README.md).

```
mqtt in  zigbee2mqtt/shower-cabin  ─┐
                                    ├─>  function  ─┬─>  mqtt out  RAMSES/GATEWAY/18:333333/tx
mqtt in  zigbee2mqtt/bathroom      ─┘               └─>  debug
```

[`flow.json`](flow.json) imports into Node-RED as a tab. [`drying-flow.js`](drying-flow.js) is the
same function node on its own if you would rather read it than import it.

Before it will do anything: substitute the three RAMSES addresses at the top of the function,
point the two `mqtt in` nodes at your own sensor topics, and set the broker in the `mqtt-broker`
config node. The sensors here are HOBEIAN ZG-227Z, but anything that publishes JSON with
`temperature` and `humidity` works.

## What it does

Either sensor can start a cycle. The cycle ends when both are below their release points, or when
absolute humidity stops falling, or on the eight hour backstop.

| Constant | Value | Meaning |
|---|---|---|
| `CABIN_ON` / `CABIN_OFF` | 80% / 75% | start and release, sensor inside the cabin |
| `BATH_ON` / `BATH_OFF` | 60% / 55% | start and release, sensor in the room |
| `BOOST` | 30 min | length of each `22F3` sent |
| `REISSUE` | 25 min | how often the boost is renewed, must stay under `BOOST` |
| `STAND` | 2 | the stand the boost holds |
| `PLATEAU` | 45 min | no fall in absolute humidity this long means it is as dry as it gets |
| `STEP_G` | 0.3 g/m3 | a fall this size counts as progress |
| `MAX_MINS` | 480 min | backstop only, the plateau is the real stop |
| `NEW_EVENT` | 1.0 g/m3 | rise after a stop that counts as a fresh shower |
| `STALE_MIN` | 90 min | ignore a sensor that has not reported in this long |

The thresholds are the part you should not copy. They come from one installation, and the right
numbers depend on where your sensors sit. Sensor placement changes them more than fan choice does:
a sensor inside a shower cabin reads 91 to 93% for hours after a shower, so a threshold sensible
for a room sensor parks the fan on high all night.

## Why it is built this way

Each of these replaced a version that was wrong for a reason that was not obvious until the next
measurement arrived.

### Progress is measured on absolute humidity, not RH

Ventilating pulls in cooler outside air, and falling temperature pushes relative humidity up even
while moisture is genuinely leaving. A stall guard watching RH concludes the fan is achieving
nothing exactly while it is working, and switches it off.

The flow converts temperature and RH to g/m3 with the Magnus formula and watches that. Start and
stop still use RH, because a shower is obvious in RH and a percentage means something to a person.
Only the "is this working" question uses absolute humidity.

The first live run showed it plainly. The cabin was 92% at 26.1 C, and eight minutes later it was
still 92% at 25.1 C. Same RH, less moisture.

### High is held by renewing a self-expiring boost

Repeating a 30 minute `22F3` every 25 minutes means the fan falls back on its own within half an
hour of anything going wrong: Node-RED restarting, the flow being redeployed, a sensor battery
dying, the zigbee mesh dropping. A design that sets stand 3 with `22F1` and relies on a later
message to clear it can strand the fan on high indefinitely, and the failure is silent.

The five minute overlap between `REISSUE` and `BOOST` is what makes the renewal seamless.

Keep the fan's resting stand on auto, because that is where an expiring or cancelled boost
returns to.

### The stop is a plateau, not a timer or a target

A shower cabin cannot reach a sensible target RH in a night, so a target means the fan runs to the
backstop achieving nothing. Forty-five minutes without a single fall in absolute humidity stops it
instead.

The guard also earns its place physically. If the cabin door is shut the extract cannot reach it,
humidity will not fall, and without the guard the fan runs the full eight hours for nothing.

### A stop the trigger can undo is not a stop

The first version with a plateau stop fired correctly and the trigger restarted it on the very
next reading, twice in one night, because humidity was still above the trigger. The fan ran
continuously from 23:17 to 04:33.

After a stop the flow now records the absolute humidity it gave up at, and will not start again
until either RH falls below the release point, meaning the room really did dry, or absolute
humidity rises 1.0 g/m3 above that level, meaning a fresh shower. Stale damp does not re-trigger.

### Progress is measured on whichever sensor is wettest

Drying the cabin while the room outside it climbs is not progress. A sensor that has not reported
for 90 minutes is ignored rather than trusted, since these sensors report on change and can go
quiet for an hour.

### It adopts state on the first reading after a restart

Flow context here is memory-only, so restarts are the normal case rather than an edge one. A room
that is already damp is not a shower that just started, so the first reading after a deploy sets
the baseline instead of triggering a cycle.

### It names the closed door

When a cycle stops on the plateau with the cabin still above its trigger while the room beside it
is below its own, that is the signature of moisture that cannot leave the cabin. The log line says
so, because nothing at the fan can fix it.

## Logging

The flow as published does not log anywhere. The original writes both sensors into InfluxDB,
throttled to one point every 20 seconds on change with a five minute heartbeat so a flat line
records as a flat line rather than as a gap. Those nodes are stripped here because they carry
site-specific config, but some logging is worth adding before you tune any threshold. Resolution
is limited by the sensor rather than the flow: these report roughly every 15 minutes when readings
are stable, so a drying curve gets about four points an hour whatever you do.
