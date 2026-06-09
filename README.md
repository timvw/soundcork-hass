# SoundCork for Home Assistant

Home Assistant integration for [SoundCork](https://github.com/timvw/soundcork) — control your Bose SoundTouch speakers after the Bose cloud shutdown.

## What it does

- Creates `media_player` entities for each registered Bose SoundTouch speaker
- Real-time state updates via WebSocket (volume, now-playing, presets)
- Lovelace card with now-playing display, preset grid, remote control, and recents

All speaker communication is **proxied through the SoundCork server** — Home Assistant never needs direct LAN access to speakers.

## Prerequisites

- [SoundCork](https://github.com/timvw/soundcork) running with speakers registered in the webui
- SoundCork version with `/api/v1` router (branch `ha-integration` or later)
- Home Assistant 2024.1+

## Installation

### Via HACS (recommended)

1. Open HACS in Home Assistant
2. Click the three dots menu → **Custom repositories**
3. Add `https://github.com/timvw/soundcork-hass` as type **Integration**
4. Search for **SoundCork** and install
5. Restart Home Assistant

### Manual

Copy `custom_components/soundcork/` to your HA config directory:

```bash
cp -r custom_components/soundcork/ /path/to/ha-config/custom_components/soundcork/
```

Restart Home Assistant.

## Configuration

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **SoundCork**
3. Enter the SoundCork server URL

| Environment | URL |
|-------------|-----|
| K8s in-cluster | `http://soundcork.soundcork.svc.cluster.local:8000` |
| Same host | `http://localhost:8000` |
| LAN | `http://192.168.1.x:8000` |

The integration validates the connection by fetching the speaker list and creates entities automatically.

## Lovelace Card

The card is auto-registered when the integration loads — no manual resource step needed.

Add to a dashboard:

```yaml
type: custom:soundcork-card
soundcork_url: https://soundcork.apps.timvw.be
speakers:
  - media_player.soundcork_A0F6FD743B41
  - media_player.soundcork_587A6274B5C4
```

> **Note**: The `soundcork_url` in the card config must be reachable from your **browser** (not the HA pod). Use the external/LAN URL, not the k8s in-cluster URL.

### Card Features

| Tab | Features |
|-----|----------|
| **Now Playing** | Album art, track/artist/album, source badge, play/pause/prev/next, per-speaker volume + mute, speaker selector chips |
| **Presets** | 2×3 grid with artwork, click to play, multi-room zone support, inline preset editor (TuneIn search, internet radio URL, delete) |
| **Remote** | Button grid: Power, AUX, Presets 1-6, Mute, Vol ±, Play/Pause, Prev, Next |
| **Recents** | Recently played items with thumbnails, source badges, play buttons |

## Architecture

```
┌─────────────┐     REST /api/v1/*      ┌──────────────┐    port 8090    ┌──────────────┐
│   Home      │ ◄──────────────────────► │  SoundCork   │ ◄────────────► │ Bose Speaker │
│  Assistant  │     WS /api/v1/ws/*      │   Server     │    port 8080   │  (LAN)       │
└─────────────┘                          └──────────────┘                └──────────────┘
```

- **Integration** (runs in HA pod): Polls SoundCork REST API every 30s, maintains WebSocket connections through soundcork's proxy for real-time updates
- **Lovelace card** (runs in browser): Reads HA entity state for display, calls SoundCork API for commands and features not in entity state (presets, recents, remote keys)

## Entities

Each speaker creates a `media_player` entity with:

| Property | Source |
|----------|--------|
| State | playing / paused / buffering / off |
| Volume | 0.0–1.0 from speaker |
| Media title | Track name or station name |
| Media artist | Artist name |
| Media album | Album name |
| Media image | Album art URL |
| Source | Current preset name or source type |
| Source list | Preset names |

Extra attributes: `ip_address`, `device_id`, `source_type`, `preset_N_name`, `preset_N_source`

## Custom Services

| Service | Description |
|---------|-------------|
| `soundcork.play_preset` | Play preset 1–6 by number |
| `soundcork.store_preset_tunein` | Save a TuneIn station to a preset slot |
| `soundcork.store_preset_radio` | Save a direct stream URL to a preset slot |

## API Reference

The SoundCork server's `/api/v1` router exposes these endpoints (see [soundcork docs](https://github.com/timvw/soundcork/blob/ha-integration/docs/home-assistant.md) for details):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/speakers` | GET | List speakers |
| `/api/v1/speakers/{ip}/now-playing` | GET | Playback state |
| `/api/v1/speakers/{ip}/volume` | GET/POST | Get/set volume |
| `/api/v1/speakers/{ip}/presets` | GET | Speaker presets |
| `/api/v1/speakers/{ip}/store-preset` | POST | Save preset |
| `/api/v1/speakers/{ip}/select` | POST | Play content item |
| `/api/v1/speakers/{ip}/key/{key}` | POST | Send remote key |
| `/api/v1/speakers/{ip}/power-on` | POST | Power on |
| `/api/v1/speakers/{ip}/power-off` | POST | Power off |
| `/api/v1/speakers/{ip}/recents` | GET | Recent items |
| `/api/v1/zone/set` | POST | Create multi-room zone |
| `/api/v1/zone/clear/{ip}` | POST | Dissolve zone |
| `/api/v1/tunein/search?q=` | GET | Search TuneIn |
| `/api/v1/ws/speaker/{ip}` | WS | Real-time updates |

## License

MIT
