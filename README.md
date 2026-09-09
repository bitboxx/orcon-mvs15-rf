# Orcon MVS-15 over RF

Two-way control of an Orcon MVS-15 SmartLine ventilation unit from Home Assistant, Node-RED or
anything else that speaks MQTT, without cutting into the appliance and without giving up the
existing wall remote.

Everything marked verified here was sent to or received from a real MVS-15RHB in September 2026.
Where a public source says something different, that is called out rather than quietly corrected,
because the differences are the interesting part.

## Background

Orcon sells no wifi module and no app for the MVS-15 SmartLine. There is nothing to enable and
nothing to buy from Orcon. Every route to automating one is community built, and most of the ones
you will find first are worse than this one: wiring an ESP into the fan's control board means
opening a live 230 V appliance and losing the humidity sensor's own logic, and soldering an ESP
onto the buttons of a spare 15RF remote costs more than a radio gateway and gives you no fan
state back.

The RF link between the 15RF wall remote and the fan is not proprietary. It is Honeywell
RAMSES II: 868.3 MHz, 2-FSK, Manchester encoded, a CC1101 radio at both ends. Same protocol
evohome uses, which is why the tooling comes out of the evohome ecosystem rather than the
ventilation one. Do not confuse it with Itho CVE, which uses a different CC1101 protocol called
`IthoEcoFanRFT` that people mix up with this one constantly.

It is genuinely two-way. The fan answers, so you get state and humidity back rather than firing
commands into the dark.

### What you need

A RAMSES II gateway: an ESP32 with a CC1101 running [ramses_esp](https://github.com/IndaloTech/ramses_esp),
which bridges the radio to MQTT. Assembled boards exist for about 35 euro, and there is a
[fork for single-core ESP32-C6](https://github.com/IMMRMKW/ramses_esp) if that is what your board
has. That is the whole shopping list. The `ramses_cc` Home Assistant integration is optional and
this repo does not use it, for reasons under [ramses_rf and 22F3](#ramses_rf-and-22f3) below.

## Control without binding

The usual advice is to bind the gateway to the fan with `1FC9`, which is fiddly on MVS-15 units
and costs an evening.

Skip it. RAMSES II has no authentication. The fan accepts any command carrying a source address
it already knows, so transmit as the wall remote and the fan obeys. Proven both ways:

| Sent | Result |
|---|---|
| `I --- 18:333333 29:111111 --:------ 22F1 003 000104` | transmitted, fan ignored it, the gateway's own address is not bound |
| `I --- 29:222222 29:111111 --:------ 22F1 003 000104` | fan answered `31D9 003 000001` in 15 ms, went to stand 1 |

What it costs you is that the fan cannot tell the gateway from the remote, so both appear in its
logs as one device. Nothing needs them separated. The physical remote keeps working untouched,
which matters if other people in the house use it.

Addresses in this repo are placeholders. Substitute your own:

| Placeholder | Device |
|---|---|
| `29:111111` | the fan |
| `29:222222` | the 15RF wall remote, the identity to transmit as |
| `18:333333` | the gateway |

To find them, subscribe to the gateway's `/rx` topic and press buttons on the remote. Every press
puts a `22F1` on the air from the remote to the fan, and the fan answers within about 15 ms.

## Topics

| Direction | Topic | Payload |
|---|---|---|
| send | `RAMSES/GATEWAY/18:333333/tx` | `{"msg":"<frame>"}` |
| receive | `RAMSES/GATEWAY/18:333333/rx` | `{"msg":"<rssi> <frame>","ts":"<iso8601>"}` |

## Frame shape

```
I --- 29:222222 29:111111 --:------ 22F1 003 000404
│   │  │         │         │        │    │   └ payload
│   │  │         │         │        │    └ payload length in bytes, 3 digits
│   │  │         │         │        └ opcode
│   │  │         │         └ third address slot, unused, always --:------
│   │  │         └ destination, the fan
│   │  └ source, the remote you impersonate
│   └ always ---
└ verb: I to tell, RQ to ask, W to write, RP to answer
```

Exactly eight space-separated tokens. The gateway rejects anything else without explanation.

## Setting a speed: 22F1

Length is always `003`. Middle byte is the setting. See
[the trailing byte](#the-trailing-byte-is-per-remote) for the last one.

| Payload | Does | Verified |
|---|---|---|
| `000004` | away, extra low, ignores the sensors | no |
| `000104` | stand 1, low | yes |
| `000204` | stand 2, medium | yes |
| `000304` | stand 3, high | yes |
| `000404` | auto, the only sensor-driven mode | yes |
| `000504` | auto2 | no |
| `000604` | boost | no |
| `000704` | disable | no |

The verified rows were each confirmed twice: once by pressing the physical remote and reading the
frame off the air, and once by transmitting it and watching the fan act.

Away is the one to be careful with. It ignores the humidity sensor entirely, so a fan left there
will not respond to a shower.

### The trailing byte is per remote

This is the trap. Every public example you will find sends `000007`, `000107`, `000207`. This unit
sends `04`. Both are correct.

The payload reads as index, speed, number of settings, so the last byte reports how many settings
the remote offers rather than being a fixed suffix. A six-button 15RF gives `07`, the four-position
one here gives `04`. `ramses_rf` hardcodes `07` for Orcon, and the widely copied Home Assistant
forum example was captured from a VMN-15LF01.

Copying a payload verbatim from any of those gets the speed byte right and the last byte wrong.
Sniff your own remote before trusting a table, this one included.

## Timed boost: 22F3

Length `007`. The remote only exposes this as three durations at high speed. It is more general
than that.

| Byte | Meaning |
|---|---|
| +0 | header / domain |
| +1 | flags |
| +2 | duration in minutes, hex |
| +3 | stand to hold |
| +4 | fallback mode |
| +5 | fallback stand |
| +6 | trailing byte, `04` on this unit |

| Payload | Does | Verified |
|---|---|---|
| `00120F03040404` | 15 minutes high | yes |
| `00121E03040404` | 30 minutes high | no |
| `00123C03040404` | 60 minutes high | no |
| `00120502040404` | 5 minutes at stand 2 | yes |

Any duration works, not just the three the remote's clock button offers. `0F` is 15, `1E` is 30,
`3C` is 60, so `0A` gives 10 minutes and `05` gives 5.

The stand byte is free too. `00120502040404` came back as `31D9 003 000002`, so a timed stand 2
works even though no button on the remote produces one. That makes the whole speed range available
as a self-expiring boost instead of only high, which is what the drying flow in this repo relies
on.

When the timer runs out this unit returns to the last chosen stand, not to auto, so send a `22F1`
auto before the boost if you want it to land on auto afterwards. To cancel a running timer early,
send any `22F1`. Byte +4 is nominally a fallback mode and reads as auto here, which contradicts
that observation, so either the fan ignores the field or the original observation was made with
auto already selected. Untested.

## Reading state: 31D9

The fan broadcasts this unprompted on every change, so state needs no polling. It arrives about
15 ms after a command lands, usually twice about a second apart.

```
046  I --- 29:111111 --:------ 29:111111 31D9 003 000003
                                                  └ current setting, same numbering as 22F1
```

## Humidity: 12A0, and device info: 10E0

Both need `RQ` rather than `I`, and the fan answers with `RP`.

```
RQ --- 29:222222 29:111111 --:------ 12A0 001 00
RP --- 29:111111 29:222222 --:------ 12A0 002 0038      -> 0x38 = 56% RH
```

Payload is an index byte then humidity as a plain percentage byte. This is a humidity source that
needs no zigbee sensor, reading the mixed extract air.

```
RQ --- 29:222222 29:111111 --:------ 10E0 001 00
RP --- 29:111111 29:222222 --:------ 10E0 029 000001C8260E0467FF...564D432D31355250303100
```

The tail of the `10E0` payload is ASCII. `564D432D3135525030 31` spells `VMC-15RP01`, the
controller board.

## Filtering what arrives

Two kinds of frame on `/rx` are not from your fan and will wreck any flow that assumes otherwise.

Your own transmissions echo back with RSSI `000`. Anything with a real signal strength was
received off the air. Drop the zeros or a flow will react to its own commands.

Neighbours are on the same band. Expect to see other `29:` and `37:` addresses, including `31D9`
broadcasts with a 17-byte payload rather than the 3-byte one your fan sends. Filter on your fan's
address rather than on the opcode.

## What the public sources actually say

Checked September 2026. All of this is public, but spread across three places of very different
quality, and the one that reads most like documentation is the least reliable.

The [ramses_protocol wiki](https://github.com/ramses-rf/ramses_protocol/wiki) has pages for both
opcodes. The `22F1` page carries only observations from an Itho remote and labels `000404` as
high, `000304` as medium. On an Orcon `000404` is auto, so following it sends the fan to auto when
you asked for high. The `22F3` page says "it is unclear if the package payload is actually used",
which is wrong on this unit.

The Orcon speed map is in `ramses_rf`'s source rather than its docs. `_22F1_MODE_ORCON` in
`src/ramses_rf/models/hvac_schemas.py` matches the table above exactly, and there is an
`OrconStrategy` class with Dutch aliases, so Orcon is a first-class scheme in that library.

The 22F3 stand byte was never unknown. `HvacVentilationControlPayload` in
`src/ramses_rf/payloads/hvac.py` documents the 7-byte form and names byte +3 `fan_mode_byte`. It
is worth transmitting once and watching the `31D9` before trusting it, but it is documented.

### ramses_rf and 22F3

Worth knowing before you let `ramses_cc` send a timed boost. The two code paths in
`HvacVentilationControlPayload` disagree about which flag bit means the duration is in hours.
`from_bytes` multiplies by 60 when `flags & 0x40`; `to_bytes` divides by 60 when `flags & 0x10`.
The flags byte in a real 15RF boost frame is `12`, which has `0x10` set, so a 15 minute boost
round-tripped through that class comes back as 0 minutes.

Publishing raw frames over MQTT sidesteps this, which is one reason this repo does that instead.

## Worked examples

Set to auto:

```sh
mosquitto_pub -h your-broker -t 'RAMSES/GATEWAY/18:333333/tx' \
  -m '{"msg":"I --- 29:222222 29:111111 --:------ 22F1 003 000404"}'
```

Boost for 15 minutes and land back on auto afterwards, so send auto first:

```sh
mosquitto_pub -h your-broker -t 'RAMSES/GATEWAY/18:333333/tx' \
  -m '{"msg":"I --- 29:222222 29:111111 --:------ 22F1 003 000404"}'
mosquitto_pub -h your-broker -t 'RAMSES/GATEWAY/18:333333/tx' \
  -m '{"msg":"I --- 29:222222 29:111111 --:------ 22F3 007 00120F03040404"}'
```

Watch everything the fan says:

```sh
mosquitto_sub -h your-broker -t 'RAMSES/GATEWAY/18:333333/rx' -v
```

## The drying flow

[`node-red/`](node-red/) has a flow that dries a bathroom out after a shower and then stops, driven
by two zigbee temperature and humidity sensors. It is the part that took the measurements below,
and the design notes in [node-red/README.md](node-red/README.md) are more useful than the code.

Four things in it were arrived at the hard way and are worth stealing even if you write your own:

Judge progress on absolute humidity, never on relative. Ventilating pulls in cooler air, and
falling temperature pushes RH up while moisture is genuinely leaving. A stall guard watching RH
concludes the fan is achieving nothing exactly while it is working.

Hold high by renewing a self-expiring `22F3` rather than setting a stand and clearing it later.
If the flow dies, gets redeployed, or the sensor battery goes flat, the boost expires by itself
within half an hour. A design that sets stand 3 and relies on a later message can strand the fan
on high indefinitely, and the failure is silent.

Stop on a plateau, not on a timer or a target RH. In a shower cabin, RH targets are unreachable
in a night, so a fixed target means the fan runs until the backstop achieving nothing.

Make the stop stick. The first version stopped correctly and the trigger restarted it on the next
reading, twice in one night, because humidity was still above the trigger. A stop that the trigger
can immediately reverse is not a stop. After stopping, wait for either a genuine dry-out or a
fresh rise in absolute humidity before starting again.

## What the measurements showed

The useful result is not about the fan.

| Run | Removed | Rate |
|---|---|---|
| shower cabin door open, 163 min | 5.1 g/m3 | 1.9 g/m3 per hour |
| shower cabin door closed, 46 min | 0.2 g/m3 | 0.26 g/m3 per hour |

Same fan, same trigger, same hot cabin straight after a shower, one variable. Leaving the cabin
door open is worth roughly seven times anything available at the fan.

Polling the fan's own `12A0` mid-run explains why. The cabin read 93% while the fan's sensor in
the extract path read 56%, which at any plausible plant room temperature is about the same
moisture content as the outdoor air at the time. The unit was extracting air no wetter than
outdoors, so the cabin's moisture was not reaching it at all. Running the fan harder or longer
moves dry air past a closed box.

If you are automating ventilation to solve a damp shower cabin, measure this before buying
anything. The answer may be a habit rather than hardware.

## Sources

- [ramses_rf](https://github.com/zxdavb/ramses_rf), the protocol implementation, and the
  [ramses_protocol wiki](https://github.com/ramses-rf/ramses_protocol/wiki)
- [ramses_esp](https://github.com/IndaloTech/ramses_esp) and its
  [ESP32-C6 fork](https://github.com/IMMRMKW/ramses_esp)
- [ramses_cc](https://github.com/ramses-rf/ramses_cc), the Home Assistant integration
- [tyz/orcon-mvs15](https://github.com/tyz/orcon-mvs15), a known-good `ramses_cc` config for this
  fan family
- [Home Assistant community thread on Itho / Orcon / Nuaire fans over RF](https://community.home-assistant.io/t/itho-orco-nuaire-fan-metrics-remote-control-sensor-faking-via-rf/451296)
- [peeter123/orcon-15rf-protocol-decoder](https://github.com/peeter123/orcon-15rf-protocol-decoder),
  an rtl_433 decoder, useful for sniffing before buying a gateway

## Licence

MIT. The protocol details are observations of a device, not anyone's copyrightable work, so use
them however you like.
