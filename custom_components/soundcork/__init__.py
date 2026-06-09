"""SoundCork integration for Home Assistant."""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_BASE_URL, DOMAIN
from .coordinator import SoundCorkCoordinator

LOGGER = logging.getLogger(__name__)

PLATFORMS = ["media_player"]

CARD_PATH = "/soundcork/soundcork-card.js"
CARD_FILE = str(Path(__file__).parent / "www" / "soundcork-card.js")


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register the lovelace card as a frontend resource."""
    hass.http.register_static_path(CARD_PATH, CARD_FILE, cache_headers=True)
    add_extra_js_url(hass, CARD_PATH)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up SoundCork from a config entry."""
    coordinator = SoundCorkCoordinator(hass, entry.data[CONF_BASE_URL])

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a SoundCork config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        coordinator: SoundCorkCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_shutdown()
    return unload_ok
