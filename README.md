![Logo](admin/pjlink-class2.png)
# ioBroker.pjlink-class2

[![NPM version](https://img.shields.io/npm/v/iobroker.pjlink-class2.svg)](https://www.npmjs.com/package/iobroker.pjlink-class2)
[![Downloads](https://img.shields.io/npm/dm/iobroker.pjlink-class2.svg)](https://www.npmjs.com/package/iobroker.pjlink-class2)
![Number of Installations](https://iobroker.live/badges/pjlink-class2-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/pjlink-class2-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.pjlink-class2.png?downloads=true)](https://nodei.co/npm/iobroker.pjlink-class2/)

**Tests:** ![Test and Release](https://github.com/AlanSRU/ioBroker.pjlink-class2/workflows/Test%20and%20Release/badge.svg)

## pjlink-class2 adapter for ioBroker

Control projectors and displays via PJLink Class 1 and Class 2 (TCP/UDP 4352): power, input, mute, freeze, volume, lamp/filter/error status, search and status notifications.

## What it does

One instance drives any number of PJLink projectors or displays. It speaks the protocol directly
(no PJLink library dependency) and supports both classes:

- **Class 1:** power, input, video/audio mute, error status, lamp hours, name/manufacturer/model.
- **Class 2**, where the projector reports it: freeze, speaker and microphone volume up/down,
  serial number, software version, input terminal names, input and recommended resolution,
  filter hours, replacement lamp/filter models, **status notifications** (pushed over UDP) and
  **search** (a broadcast that finds Class 2 projectors on the local subnet).

The class is detected with `CLSS ?`. Class 2 states are only created for projectors that
report Class 2.

## Configuration

| Setting | |
|---|---|
| Projectors | One row per projector: name, IP address or host name, port (4352). The name becomes the object folder; leave it empty to use the host. |
| PJLink password | Used for every projector that asks for authentication. Stored encrypted. Both digests are supported: MD5 (older projectors) and SHA-256 (newer ones); the adapter finds out which one a projector accepts. |
| Status poll interval | Power, input, mute, freeze, error status and input resolution. Default 5 s. |
| Information poll interval | Names, inputs, lamps and other slow-changing values. Default 300 s. They are also read on (re)connect and after a Class 2 `LKUP` notification. |
| Listen on UDP 4352 | Receives Class 2 notifications and search replies. Only one program per host can listen on this port, which is why one instance handles all projectors. |
| Search broadcast addresses | Where the **Search** button sends `%2SRCH`. Use a directed broadcast (e.g. `192.168.254.255`) for a subnet; broadcasts do not cross routers. |

Class 1 projectors do not answer a search and must be added by hand.

## States

```
info.connection                      true if any projector answered its last poll
<projector>.info.connection          this projector answered its last poll
<projector>.info.class               1 or 2
<projector>.info.name / manufacturer / model / other
<projector>.info.inputs              JSON: input code -> name
<projector>.info.lastError           last refused command, e.g. "POWR 1: ERR3 (unavailable time)"
<projector>.control.power      (rw)  true while On or Warming
<projector>.control.input      (rw)  PJLink input code, e.g. "31" (Digital 1); Class 2 codes may be alphanumeric ("3A")
<projector>.control.videoMute  (rw)
<projector>.control.audioMute  (rw)
<projector>.status.power             0 Off, 1 On, 2 Cooling, 3 Warming
<projector>.status.errors.fan / lamp / temperature / coverOpen / filter / other   0 OK, 1 Warning, 2 Error
<projector>.status.lamps.<n>.hours / .on

Class 2 only:
<projector>.control.freeze     (rw)
<projector>.control.volumeUp / volumeDown / microphoneUp / microphoneDown   (buttons)
<projector>.info.serialNumber / softwareVersion / macAddress / lampModel / filterModel / recommendedResolution
<projector>.status.inputResolution / filterHours
```

### Power commands

Projectors can keep reporting their old power status for several seconds after accepting a
command. (An NEC NP3250 reports Off for about 12 s after power-on.) So `control.power` holds the
commanded value until the projector changes state, for up to 30 s. If nothing has changed by then,
`control.power` follows the projector again and `info.lastError` says so. That happens when a
projector accepts a command but ignores it, e.g. during a rest period after cooling down. A
command the projector refuses outright (`ERR3` while warming or cooling) is reported in
`info.lastError` straight away.

## Class 2 notifications

A Class 2 projector sends notifications (power, input, error status, link up) to UDP 4352 of a
controller. Where the projector lets you set the notification destination, set it to the ioBroker host. They are matched to a projector by source IP address, so configure projectors on the
address they send from. Polling keeps running, so a missed datagram is corrected at the next
poll.

## Testing without hardware

`test/lib/simulator.ts` is a PJLink projector simulator (Class 1 or 2, optional password):

```bash
npx ts-node test/lib/simulator.ts 4353 2 secret   # port, class, password
```

## Disclaimer

PJLink is a trademark of the Japan Business Machine and Information System Industries
Association (JBMIA); see the [PJLink website](https://pjlink.jbmia.or.jp/english/). This adapter is not affiliated with or endorsed by JBMIA.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (Alan Paris) initial release

## License
MIT License

Copyright (c) 2026 Alan Paris <alan.paris@scottish.rugby>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.