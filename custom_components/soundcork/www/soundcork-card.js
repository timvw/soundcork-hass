/**
 * SoundCork Lovelace Card
 *
 * Tabbed single-card UI for Bose SoundTouch speakers via a SoundCork server.
 * HA entity state drives display; SoundCork API drives commands.
 *
 * Config:
 *   type: custom:soundcork-card
 *   soundcork_url: https://soundcork.apps.timvw.be
 *   speakers:
 *     - media_player.soundcork_A0F6FD743B41
 *     - media_player.soundcork_587A6274B5C4
 */

// ---------------------------------------------------------------------------
// Helpers (module-scoped, shared across instances)
// ---------------------------------------------------------------------------

function _escXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function _escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function _timeAgo(unixSeconds) {
  const seconds = Math.floor(Date.now() / 1000) - unixSeconds;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function _contentItemXml(item) {
  return (
    `<ContentItem source="${_escXml(item.source)}" ` +
    `type="${_escXml(item.type)}" ` +
    `location="${_escXml(item.location)}" ` +
    `sourceAccount="${_escXml(item.sourceAccount || "")}" ` +
    `isPresetable="${item.isPresetable ? "true" : "false"}">` +
    `<itemName>${_escXml(item.itemName || item.name || "")}</itemName>` +
    `<containerArt>${_escXml(item.containerArt || item.art || "")}</containerArt>` +
    `</ContentItem>`
  );
}

function _parseXmlPresets(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const presets = [];
  doc.querySelectorAll("preset").forEach((p) => {
    const ci = p.querySelector("ContentItem");
    if (ci) {
      presets.push({
        id: parseInt(p.getAttribute("id")),
        name: ci.querySelector("itemName")?.textContent || `Preset ${p.getAttribute("id")}`,
        art: ci.querySelector("containerArt")?.textContent || "",
        source: ci.getAttribute("source") || "",
        location: ci.getAttribute("location") || "",
        type: ci.getAttribute("type") || "",
        sourceAccount: ci.getAttribute("sourceAccount") || "",
        isPresetable: ci.getAttribute("isPresetable") === "true",
      });
    }
  });
  return presets;
}

function _parseXmlRecents(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const recents = [];
  doc.querySelectorAll("recent").forEach((r) => {
    const ci = r.querySelector("ContentItem");
    if (ci) {
      recents.push({
        utcTime: parseInt(r.getAttribute("utcTime") || "0"),
        name: ci.querySelector("itemName")?.textContent || "",
        art: ci.querySelector("containerArt")?.textContent || "",
        source: ci.getAttribute("source") || "",
        location: ci.getAttribute("location") || "",
        type: ci.getAttribute("type") || "",
        sourceAccount: ci.getAttribute("sourceAccount") || "",
        isPresetable: ci.getAttribute("isPresetable") === "true",
      });
    }
  });
  return recents.sort((a, b) => b.utcTime - a.utcTime);
}

// ---------------------------------------------------------------------------
// Card class
// ---------------------------------------------------------------------------

class SoundCorkCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    // Config & HA
    this._config = {};
    this._hass = null;

    // UI state
    this._activeTab = "playing";
    this._selectedSpeakers = null; // null = all selected
    this._initialized = false;

    // Data loaded from SoundCork API
    this._presets = [];
    this._recents = [];
    this._speakerList = []; // from /api/v1/speakers

    // Transient states
    this._playingPresetId = null;
    this._volumeDebounceTimers = {};
    this._presetEditId = null; // which preset slot is being edited
    this._editMode = null; // "tunein" | "radio" | null
    this._tuneinQuery = "";
    this._tuneinResults = [];
    this._tuneinSearching = false;
    this._tuneinDetail = null;
    this._radioName = "";
    this._radioUrl = "";
    this._radioArt = "";
  }

  // -----------------------------------------------------------------------
  // HA lifecycle
  // -----------------------------------------------------------------------

  setConfig(config) {
    if (!config.soundcork_url) throw new Error("soundcork_url is required");
    if (!config.speakers || !config.speakers.length)
      throw new Error("At least one speaker entity is required");
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._bootstrap();
    }
    this._render();
  }

  static getConfigElement() {
    return document.createElement("soundcork-card-editor");
  }
  static getStubConfig() {
    return { soundcork_url: "", speakers: [] };
  }
  getCardSize() {
    return 6;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  get _baseUrl() {
    return (this._config.soundcork_url || "").replace(/\/$/, "");
  }
  get _speakers() {
    return this._config.speakers || [];
  }

  _proxyImage(url) {
    if (!url) return "";
    if (url.startsWith("/")) return url; // already local
    return `${this._baseUrl}/webui/api/image?url=${encodeURIComponent(url)}`;
  }

  _sourceBadgeHtml(source) {
    const s = (source || "").toUpperCase();
    if (s.includes("SPOTIFY"))
      return '<span class="badge badge-spotify">Spotify</span>';
    if (s.includes("TUNEIN"))
      return '<span class="badge badge-tunein">TuneIn</span>';
    if (s.includes("RADIO") || s.includes("LOCAL_INTERNET"))
      return '<span class="badge badge-radio">Radio</span>';
    if (s && s !== "STANDBY")
      return `<span class="badge badge-product">${_escHtml(s)}</span>`;
    return "";
  }

  // -----------------------------------------------------------------------
  // Speaker helpers
  // -----------------------------------------------------------------------

  _getSpeakerEntities() {
    return this._speakers
      .map((id) => {
        const state = this._hass && this._hass.states[id];
        return state ? { id, state } : null;
      })
      .filter(Boolean);
  }

  _getSelectedEntities() {
    const ids =
      this._selectedSpeakers && this._selectedSpeakers.length > 0
        ? this._selectedSpeakers
        : this._speakers;
    return ids
      .map((id) => {
        const state = this._hass && this._hass.states[id];
        if (!state || state.state === "unavailable") return null;
        return {
          id,
          ip: state.attributes.ip_address,
          device_id: state.attributes.device_id,
          name: state.attributes.friendly_name || id.split(".")[1],
        };
      })
      .filter((s) => s && s.ip);
  }

  _getFirstAvailableIp() {
    for (const id of this._speakers) {
      const s = this._hass && this._hass.states[id];
      if (s && s.state !== "unavailable" && s.attributes.ip_address)
        return s.attributes.ip_address;
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // API helpers
  // -----------------------------------------------------------------------

  async _apiGet(path) {
    const r = await fetch(`${this._baseUrl}${path}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`API ${r.status}`);
    return r;
  }

  async _apiPost(path, body, contentType = "application/xml") {
    const r = await fetch(`${this._baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`API ${r.status}`);
    return r;
  }

  async _sendKey(ip, key) {
    await this._apiPost(`/api/v1/speakers/${ip}/key/${key}`, "").catch(
      () => {}
    );
  }

  async _sendKeyToSelected(key) {
    const targets = this._getSelectedEntities();
    await Promise.all(targets.map((t) => this._sendKey(t.ip, key)));
  }

  async _selectOnTargets(contentItemXml) {
    const targets = this._getSelectedEntities();
    if (!targets.length) return;
    if (targets.length === 1) {
      await this._apiPost(
        `/api/v1/speakers/${targets[0].ip}/select`,
        contentItemXml
      ).catch(() => {});
    } else {
      const master = targets[0];
      const slaves = targets.slice(1);
      await this._apiPost(
        "/api/v1/zone/set",
        JSON.stringify({
          master_ip: master.ip,
          master_device_id: master.device_id,
          slaves: slaves.map((s) => ({ ip: s.ip, device_id: s.device_id })),
        }),
        "application/json"
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      await this._apiPost(
        `/api/v1/speakers/${master.ip}/select`,
        contentItemXml
      ).catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  async _bootstrap() {
    await Promise.all([this._loadSpeakers(), this._loadPresets()]);
  }

  async _loadSpeakers() {
    try {
      const r = await this._apiGet("/api/v1/speakers");
      this._speakerList = await r.json();
    } catch (e) {
      this._speakerList = [];
    }
  }

  async _loadPresets() {
    const ip = this._getFirstAvailableIp();
    if (!ip) return;
    try {
      const r = await this._apiGet(`/api/v1/speakers/${ip}/presets`);
      this._presets = _parseXmlPresets(await r.text());
      this._render();
    } catch (e) {
      /* ignore */
    }
  }

  async _loadRecents() {
    const ip = this._getFirstAvailableIp();
    if (!ip) return;
    try {
      const r = await this._apiGet(`/api/v1/speakers/${ip}/recents`);
      this._recents = _parseXmlRecents(await r.text());
      this._render();
    } catch (e) {
      /* ignore */
    }
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  async _playPreset(preset) {
    if (this._playingPresetId) return;
    this._playingPresetId = preset.id;
    this._render();
    const xml = _contentItemXml(preset);
    await this._selectOnTargets(xml);
    this._playingPresetId = null;
    this._render();
  }

  async _playRecent(recent) {
    const xml = _contentItemXml(recent);
    await this._selectOnTargets(xml);
  }

  async _setVolume(ip, vol) {
    await this._apiPost(
      `/api/v1/speakers/${ip}/volume`,
      `<volume>${Math.max(0, Math.min(100, vol))}</volume>`
    ).catch(() => {});
  }

  async _toggleMute(ip) {
    await this._sendKey(ip, "MUTE");
  }

  async _storePresetTuneIn(slot, stationId, name, art) {
    const ip = this._getFirstAvailableIp();
    if (!ip) return;
    const xml =
      `<preset id="${slot}">` +
      `<ContentItem source="TUNEIN" type="stationurl" ` +
      `location="/v1/playback/station/${_escXml(stationId)}" ` +
      `isPresetable="true">` +
      `<itemName>${_escXml(name)}</itemName>` +
      `<containerArt>${_escXml(art)}</containerArt>` +
      `</ContentItem></preset>`;
    const ips = this._getSelectedEntities().map((s) => s.ip);
    await Promise.all(
      ips.map((i) =>
        this._apiPost(`/api/v1/speakers/${i}/store-preset`, xml).catch(
          () => {}
        )
      )
    );
    await this._loadPresets();
  }

  async _storePresetRadio(slot, streamUrl, name, art) {
    const ip = this._getFirstAvailableIp();
    if (!ip) return;
    const xml =
      `<preset id="${slot}">` +
      `<ContentItem source="LOCAL_INTERNET_RADIO" type="stationurl" ` +
      `location="${_escXml(streamUrl)}" isPresetable="true">` +
      `<itemName>${_escXml(name)}</itemName>` +
      `<containerArt>${_escXml(art)}</containerArt>` +
      `</ContentItem></preset>`;
    const ips = this._getSelectedEntities().map((s) => s.ip);
    await Promise.all(
      ips.map((i) =>
        this._apiPost(`/api/v1/speakers/${i}/store-preset`, xml).catch(
          () => {}
        )
      )
    );
    await this._loadPresets();
  }

  async _deletePreset(slot) {
    const ip = this._getFirstAvailableIp();
    if (!ip) return;
    await this._apiPost(
      `/api/v1/speakers/${ip}/key/PRESET_${slot}`,
      ""
    ).catch(() => {});
    // Bose API doesn't have a direct delete; re-load to see current state
    await this._loadPresets();
  }

  async _searchTuneIn(query) {
    this._tuneinSearching = true;
    this._tuneinResults = [];
    this._tuneinDetail = null;
    this._render();
    try {
      const r = await this._apiGet(
        `/api/v1/tunein/search?q=${encodeURIComponent(query)}`
      );
      const data = await r.json();
      this._tuneinResults = (data.body || [])
        .flatMap((g) => g.children || [])
        .filter((c) => c.type === "audio");
    } catch (e) {
      this._tuneinResults = [];
    }
    this._tuneinSearching = false;
    this._render();
  }

  async _describeTuneIn(guideId) {
    try {
      const r = await this._apiGet(
        `/api/v1/tunein/describe?id=${encodeURIComponent(guideId)}`
      );
      const data = await r.json();
      const items = (data.body || []).flatMap((g) => g.children || []);
      return items[0] || null;
    } catch (e) {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Render orchestration
  // -----------------------------------------------------------------------

  _render() {
    if (!this.shadowRoot || !this._config.soundcork_url) return;

    const root = this.shadowRoot;

    // Build full HTML
    root.innerHTML = `<style>${this._css()}</style>
      <ha-card>
        <div class="sc-card">
          ${this._renderTabBar()}
          <div class="tab-content">
            ${this._renderActiveTab()}
          </div>
        </div>
      </ha-card>`;

    this._attachEvents();
  }

  _renderTabBar() {
    const tabs = [
      { id: "playing", label: "Now Playing" },
      { id: "presets", label: "Presets" },
      { id: "remote", label: "Remote" },
      { id: "recents", label: "Recents" },
    ];
    return `<div class="tab-bar">${tabs
      .map(
        (t) =>
          `<button class="tab-btn ${this._activeTab === t.id ? "active" : ""}" data-tab="${t.id}">${_escHtml(t.label)}</button>`
      )
      .join("")}</div>`;
  }

  _renderActiveTab() {
    switch (this._activeTab) {
      case "playing":
        return this._renderNowPlaying();
      case "presets":
        return this._renderPresets();
      case "remote":
        return this._renderRemote();
      case "recents":
        return this._renderRecents();
      default:
        return "";
    }
  }

  // -----------------------------------------------------------------------
  // Tab 1: Now Playing
  // -----------------------------------------------------------------------

  _renderNowPlaying() {
    const primary = this._speakers[0];
    const state = this._hass && primary && this._hass.states[primary];
    const attrs = state ? state.attributes : {};
    const isOff =
      !state || state.state === "off" || state.state === "unavailable";

    // Album art: use entity_picture from HA, proxy external URLs
    let artUrl = "";
    if (attrs.entity_picture) {
      artUrl = attrs.entity_picture.startsWith("http")
        ? this._proxyImage(attrs.entity_picture)
        : attrs.entity_picture;
    }

    const title = attrs.media_title || (isOff ? "Standby" : "Playing");
    const artist = attrs.media_artist || "";
    const album = attrs.media_album_name || "";
    const sourceType = attrs.source_type || "";

    // Playback controls
    const controls = `
      <div class="playback-controls">
        <button class="ctrl-btn" data-action="PREV_TRACK" title="Previous">⏮️</button>
        <button class="ctrl-btn ctrl-btn-lg" data-action="PLAY_PAUSE" title="Play/Pause">⏯️</button>
        <button class="ctrl-btn" data-action="NEXT_TRACK" title="Next">⏭️</button>
      </div>`;

    // Volume sliders per speaker
    const volumeRows = this._getSpeakerEntities()
      .map((e) => {
        const a = e.state.attributes;
        const vol = Math.round((a.volume_level || 0) * 100);
        const muted = a.is_volume_muted;
        const ip = a.ip_address;
        const speakerOff =
          e.state.state === "off" || e.state.state === "unavailable";
        return `
        <div class="vol-row">
          <span class="vol-name">${_escHtml(a.friendly_name || e.id.split(".")[1])}</span>
          <div class="vol-controls">
            <button class="mute-btn ${muted ? "muted" : ""}" data-mute-ip="${_escHtml(ip)}" title="Mute">${muted ? "🔇" : "🔊"}</button>
            <input type="range" min="0" max="100" value="${vol}" data-vol-ip="${_escHtml(ip)}" ${speakerOff ? "disabled" : ""}>
            <span class="vol-label">${vol}</span>
          </div>
        </div>`;
      })
      .join("");

    // Speaker selector chips (only if multiple)
    const chips =
      this._speakers.length > 1 ? this._renderSpeakerChips() : "";

    return `
      <div class="now-playing">
        ${
          artUrl
            ? `<img class="np-art" src="${_escHtml(artUrl)}" alt="" onerror="this.style.display='none'">`
            : `<div class="np-placeholder">${isOff ? "⏻" : "♫"}</div>`
        }
        <div class="np-info">
          <div class="np-track">${_escHtml(title)}</div>
          ${artist ? `<div class="np-artist">${_escHtml(artist)}</div>` : ""}
          ${album ? `<div class="np-album">${_escHtml(album)}</div>` : ""}
          <div class="np-source">${this._sourceBadgeHtml(sourceType)}</div>
        </div>
      </div>
      ${controls}
      ${chips}
      <div class="section-title">Volume</div>
      ${volumeRows || '<div class="text-muted">No speakers available</div>'}
    `;
  }

  // -----------------------------------------------------------------------
  // Tab 2: Presets
  // -----------------------------------------------------------------------

  _renderPresets() {
    // If editing a preset slot, show the edit form
    if (this._presetEditId !== null) {
      return this._renderPresetEdit();
    }

    const slots = [];
    for (let i = 1; i <= 6; i++) {
      slots.push(this._presets.find((p) => p.id === i) || { id: i, empty: true });
    }

    return `
      <div class="preset-grid">
        ${slots
          .map((p) => {
            if (p.empty) {
              return `
              <button class="preset-card preset-empty" data-preset-id="${p.id}">
                <div class="preset-num">${p.id}</div>
                <div class="preset-art-ph">+</div>
                <div class="preset-name text-muted">Empty</div>
              </button>`;
            }
            const artSrc = p.art ? this._proxyImage(p.art) : "";
            return `
            <button class="preset-card ${this._playingPresetId === p.id ? "playing" : ""}" data-preset-id="${p.id}">
              <div class="preset-num">${p.id}</div>
              ${
                artSrc
                  ? `<img class="preset-art" src="${_escHtml(artSrc)}" alt="" onerror="this.style.display='none'">`
                  : `<div class="preset-art-ph">${p.id}</div>`
              }
              <div class="preset-name">${_escHtml(p.name)}</div>
              <div class="preset-src">${this._sourceBadgeHtml(p.source)}</div>
            </button>`;
          })
          .join("")}
      </div>
      <div class="preset-actions">
        ${slots
          .map(
            (p) =>
              `<button class="btn btn-sm" data-manage-preset="${p.id}">Manage #${p.id}</button>`
          )
          .join("")}
      </div>
    `;
  }

  _renderPresetEdit() {
    const slot = this._presetEditId;
    const existing = this._presets.find((p) => p.id === slot);

    let editContent = "";

    if (this._editMode === "tunein") {
      editContent = this._renderTuneInSearch(slot);
    } else if (this._editMode === "radio") {
      editContent = this._renderRadioForm(slot);
    } else {
      // Choice screen
      editContent = `
        <div class="edit-choices">
          ${
            existing
              ? `<div class="existing-preset-info">
                  ${existing.art ? `<img class="edit-thumb" src="${_escHtml(this._proxyImage(existing.art))}" alt="">` : ""}
                  <div><strong>${_escHtml(existing.name)}</strong></div>
                  <div>${this._sourceBadgeHtml(existing.source)}</div>
                </div>`
              : '<div class="text-muted">This slot is empty.</div>'
          }
          <div class="btn-row">
            <button class="btn btn-primary" data-edit-mode="tunein">TuneIn Search</button>
            <button class="btn" data-edit-mode="radio">Internet Radio URL</button>
            ${existing ? '<button class="btn btn-danger" data-edit-delete>Delete Preset</button>' : ""}
          </div>
        </div>`;
    }

    return `
      <div class="edit-header">
        <button class="back-btn" data-edit-back>←</button>
        <span class="edit-title">Preset ${slot}</span>
      </div>
      ${editContent}
    `;
  }

  _renderTuneInSearch(slot) {
    let resultsHtml = "";
    if (this._tuneinSearching) {
      resultsHtml = '<div class="spinner"></div>';
    } else if (this._tuneinDetail) {
      const d = this._tuneinDetail;
      resultsHtml = `
        <div class="tunein-detail">
          ${d.image ? `<img class="tunein-detail-img" src="${_escHtml(d.image)}" alt="">` : ""}
          <div class="tunein-detail-name">${_escHtml(d.text || d.guide_id)}</div>
          ${d.subtext ? `<div class="text-muted">${_escHtml(d.subtext)}</div>` : ""}
          <div class="btn-row">
            <button class="btn btn-primary" data-tunein-save="${_escHtml(d.guide_id)}">Save to Preset ${slot}</button>
            <button class="btn" data-tunein-back-results>Back to Results</button>
          </div>
        </div>`;
    } else if (this._tuneinResults.length > 0) {
      resultsHtml = `<div class="search-results">${this._tuneinResults
        .map(
          (s) => `
        <div class="list-item" data-tunein-select="${_escHtml(s.guide_id)}">
          ${
            s.image
              ? `<img class="list-thumb" src="${_escHtml(s.image)}" alt="" onerror="this.style.display='none'">`
              : '<div class="list-thumb-ph">📻</div>'
          }
          <div class="list-body">
            <div class="list-title">${_escHtml(s.text)}</div>
            <div class="list-sub">${_escHtml(s.subtext || "")}</div>
          </div>
        </div>`
        )
        .join("")}</div>`;
    }

    return `
      <div class="search-section">
        <div class="search-bar">
          <input type="text" id="tunein-input" placeholder="Search TuneIn stations..." value="${_escHtml(this._tuneinQuery)}">
          <button class="btn btn-primary btn-sm" id="tunein-search-btn">Search</button>
        </div>
        ${resultsHtml}
      </div>`;
  }

  _renderRadioForm(slot) {
    return `
      <div class="radio-form">
        <div class="form-group">
          <label>Station Name</label>
          <input type="text" id="radio-name" placeholder="My Radio Station" value="${_escHtml(this._radioName)}">
        </div>
        <div class="form-group">
          <label>Stream URL</label>
          <input type="url" id="radio-url" placeholder="https://stream.example.com/radio.mp3" value="${_escHtml(this._radioUrl)}">
        </div>
        <div class="form-group">
          <label>Cover Art URL (optional)</label>
          <input type="url" id="radio-art" placeholder="https://example.com/logo.png" value="${_escHtml(this._radioArt)}">
        </div>
        <button class="btn btn-primary" id="radio-save-btn">Save to Preset ${slot}</button>
      </div>`;
  }

  // -----------------------------------------------------------------------
  // Tab 3: Remote
  // -----------------------------------------------------------------------

  _renderRemote() {
    const chips =
      this._speakers.length > 1 ? this._renderSpeakerChips() : "";
    return `
      ${chips}
      <div class="remote-grid">
        <button class="btn remote-full" data-rkey="POWER">⏻ Power</button>
        <button class="btn remote-full" data-rkey="AUX_INPUT">🔌 AUX</button>
        <button class="btn" data-rkey="PRESET_1">1</button>
        <button class="btn" data-rkey="PRESET_2">2</button>
        <button class="btn" data-rkey="PRESET_3">3</button>
        <button class="btn" data-rkey="PRESET_4">4</button>
        <button class="btn" data-rkey="PRESET_5">5</button>
        <button class="btn" data-rkey="PRESET_6">6</button>
        <button class="btn remote-full" data-rkey="MUTE">🔇 Mute</button>
        <button class="btn" data-rkey="VOLUME_DOWN">− Vol</button>
        <button class="btn" data-rkey="VOLUME_UP">+ Vol</button>
        <div></div>
        <button class="btn remote-full" data-rkey="PLAY_PAUSE">⏯ Play/Pause</button>
        <button class="btn" data-rkey="PREV_TRACK">⏮ Prev</button>
        <div></div>
        <button class="btn" data-rkey="NEXT_TRACK">⏭ Next</button>
      </div>`;
  }

  // -----------------------------------------------------------------------
  // Tab 4: Recents
  // -----------------------------------------------------------------------

  _renderRecents() {
    if (this._recents.length === 0) {
      return '<div class="empty-state">No recent items.<br><button class="btn btn-sm" id="load-recents-btn">Load Recents</button></div>';
    }
    return `<div class="recents-list">${this._recents
      .map(
        (r, i) => `
      <div class="list-item">
        ${
          r.art
            ? `<img class="list-thumb" src="${_escHtml(this._proxyImage(r.art))}" alt="" onerror="this.style.display='none'">`
            : '<div class="list-thumb-ph">♫</div>'
        }
        <div class="list-body">
          <div class="list-title">${_escHtml(r.name)}</div>
          <div class="list-sub">${this._sourceBadgeHtml(r.source)} · ${_escHtml(_timeAgo(r.utcTime))}</div>
        </div>
        <button class="btn btn-sm" data-play-recent="${i}">▶</button>
      </div>`
      )
      .join("")}</div>`;
  }

  // -----------------------------------------------------------------------
  // Speaker chips (shared)
  // -----------------------------------------------------------------------

  _renderSpeakerChips() {
    const names = this._speakers.map((id) => {
      const s = this._hass && this._hass.states[id];
      return {
        id,
        name: s
          ? s.attributes.friendly_name || id.split(".")[1]
          : id.split(".")[1],
      };
    });
    return `<div class="speaker-chips">${names
      .map((s) => {
        const sel =
          !this._selectedSpeakers || this._selectedSpeakers.includes(s.id);
        return `<button class="chip ${sel ? "active" : ""}" data-chip-id="${_escHtml(s.id)}">${_escHtml(s.name)}</button>`;
      })
      .join("")}</div>`;
  }

  // -----------------------------------------------------------------------
  // Event binding
  // -----------------------------------------------------------------------

  _attachEvents() {
    const root = this.shadowRoot;
    if (!root) return;

    // Tab bar
    root.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._activeTab = btn.dataset.tab;
        // Reset edit state when switching tabs
        this._presetEditId = null;
        this._editMode = null;
        this._tuneinResults = [];
        this._tuneinDetail = null;
        if (this._activeTab === "recents" && this._recents.length === 0) {
          this._loadRecents();
        }
        this._render();
      });
    });

    // Speaker chips
    root.querySelectorAll(".chip[data-chip-id]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const id = chip.dataset.chipId;
        if (!this._selectedSpeakers) {
          this._selectedSpeakers = [id];
        } else if (this._selectedSpeakers.includes(id)) {
          this._selectedSpeakers = this._selectedSpeakers.filter(
            (s) => s !== id
          );
          if (this._selectedSpeakers.length === 0)
            this._selectedSpeakers = null;
        } else {
          this._selectedSpeakers.push(id);
        }
        this._render();
      });
    });

    // Playback controls
    root.querySelectorAll(".ctrl-btn[data-action]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this._sendKeyToSelected(btn.dataset.action)
      );
    });

    // Volume sliders with debounce
    root.querySelectorAll("input[data-vol-ip]").forEach((slider) => {
      slider.addEventListener("input", () => {
        const label = slider.parentElement.querySelector(".vol-label");
        if (label) label.textContent = slider.value;
        const ip = slider.dataset.volIp;
        clearTimeout(this._volumeDebounceTimers[ip]);
        this._volumeDebounceTimers[ip] = setTimeout(
          () => this._setVolume(ip, parseInt(slider.value)),
          200
        );
      });
    });

    // Mute buttons
    root.querySelectorAll(".mute-btn[data-mute-ip]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this._toggleMute(btn.dataset.muteIp)
      );
    });

    // Preset cards - click to play
    root.querySelectorAll(".preset-card[data-preset-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const id = parseInt(card.dataset.presetId);
        const preset = this._presets.find((p) => p.id === id);
        if (preset) this._playPreset(preset);
      });
    });

    // Manage preset buttons
    root.querySelectorAll("[data-manage-preset]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._presetEditId = parseInt(btn.dataset.managePreset);
        this._editMode = null;
        this._tuneinResults = [];
        this._tuneinDetail = null;
        this._radioName = "";
        this._radioUrl = "";
        this._radioArt = "";
        this._render();
      });
    });

    // Edit back button
    const backBtn = root.querySelector("[data-edit-back]");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        if (this._editMode) {
          this._editMode = null;
        } else {
          this._presetEditId = null;
        }
        this._tuneinResults = [];
        this._tuneinDetail = null;
        this._render();
      });
    }

    // Edit mode selection
    root.querySelectorAll("[data-edit-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._editMode = btn.dataset.editMode;
        this._render();
      });
    });

    // Delete preset
    const delBtn = root.querySelector("[data-edit-delete]");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        await this._deletePreset(this._presetEditId);
        this._presetEditId = null;
        this._editMode = null;
        this._render();
      });
    }

    // TuneIn search
    const tuneinInput = root.querySelector("#tunein-input");
    const tuneinSearchBtn = root.querySelector("#tunein-search-btn");
    if (tuneinInput && tuneinSearchBtn) {
      const doSearch = () => {
        const q = tuneinInput.value.trim();
        if (q) {
          this._tuneinQuery = q;
          this._searchTuneIn(q);
        }
      };
      tuneinSearchBtn.addEventListener("click", doSearch);
      tuneinInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doSearch();
      });
    }

    // TuneIn result selection
    root.querySelectorAll("[data-tunein-select]").forEach((item) => {
      item.addEventListener("click", async () => {
        const guideId = item.dataset.tuneinSelect;
        const station = this._tuneinResults.find(
          (s) => s.guide_id === guideId
        );
        if (station) {
          this._tuneinDetail = station;
          // Try to get more details
          const detail = await this._describeTuneIn(guideId);
          if (detail) {
            this._tuneinDetail = { ...station, ...detail };
          }
          this._render();
        }
      });
    });

    // TuneIn save
    root.querySelectorAll("[data-tunein-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const d = this._tuneinDetail;
        if (d) {
          await this._storePresetTuneIn(
            this._presetEditId,
            d.guide_id,
            d.text || d.guide_id,
            d.image || ""
          );
          this._presetEditId = null;
          this._editMode = null;
          this._tuneinDetail = null;
          this._render();
        }
      });
    });

    // TuneIn back to results
    const tuneinBackBtn = root.querySelector("[data-tunein-back-results]");
    if (tuneinBackBtn) {
      tuneinBackBtn.addEventListener("click", () => {
        this._tuneinDetail = null;
        this._render();
      });
    }

    // Radio form save
    const radioSaveBtn = root.querySelector("#radio-save-btn");
    if (radioSaveBtn) {
      radioSaveBtn.addEventListener("click", async () => {
        const name = root.querySelector("#radio-name").value.trim();
        const url = root.querySelector("#radio-url").value.trim();
        const art = root.querySelector("#radio-art").value.trim();
        if (!name || !url) return;
        this._radioName = name;
        this._radioUrl = url;
        this._radioArt = art;
        await this._storePresetRadio(this._presetEditId, url, name, art);
        this._presetEditId = null;
        this._editMode = null;
        this._render();
      });
    }

    // Remote keys
    root.querySelectorAll("[data-rkey]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this._sendKeyToSelected(btn.dataset.rkey)
      );
    });

    // Play recent
    root.querySelectorAll("[data-play-recent]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.playRecent);
        const recent = this._recents[idx];
        if (recent) this._playRecent(recent);
      });
    });

    // Load recents button
    const loadRecentsBtn = root.querySelector("#load-recents-btn");
    if (loadRecentsBtn) {
      loadRecentsBtn.addEventListener("click", () => this._loadRecents());
    }
  }

  // -----------------------------------------------------------------------
  // CSS
  // -----------------------------------------------------------------------

  _css() {
    return `
      :host {
        --bg-primary: var(--ha-card-background, var(--card-background-color, #fff));
        --bg-secondary: var(--secondary-background-color, #f5f5f5);
        --text-primary: var(--primary-text-color, #212121);
        --text-secondary: var(--secondary-text-color, #757575);
        --text-hint: var(--disabled-text-color, #bdbdbd);
        --border-color: var(--divider-color, #e0e0e0);
        --border-light: var(--divider-color, #f0f0f0);
        --accent: var(--primary-color, #ff5722);
        --accent-hover: var(--primary-color, #e64a19);
        --accent-light: rgba(255, 87, 34, 0.12);
        --danger: var(--error-color, #f44336);
        --success: var(--success-color, #4caf50);
        --badge-spotify: #1db954;
        --badge-tunein: #2196f3;
        --badge-radio: #ff9800;
        --badge-product: #9e9e9e;
        --radius-sm: 6px;
        --radius-md: 10px;
        --radius-lg: 16px;
        --shadow-sm: 0 1px 3px rgba(0,0,0,0.08);
        --shadow-md: 0 2px 8px rgba(0,0,0,0.12);
        --transition: 0.2s ease;
        --font-mono: 'SF Mono', 'Fira Code', monospace;
      }

      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      .sc-card {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 0.9rem;
        line-height: 1.5;
        color: var(--text-primary);
        padding: 0;
      }

      /* ---- Tab bar ---- */
      .tab-bar {
        display: flex;
        border-bottom: 1px solid var(--border-color);
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }
      .tab-btn {
        flex: 1;
        min-width: 0;
        padding: 0.7rem 0.5rem;
        font-family: inherit;
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--text-secondary);
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        cursor: pointer;
        transition: color var(--transition), border-color var(--transition);
        white-space: nowrap;
        text-align: center;
      }
      .tab-btn:hover { color: var(--text-primary); }
      .tab-btn.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }
      .tab-content { padding: 1rem; }

      /* ---- Now Playing ---- */
      .now-playing {
        border-radius: var(--radius-md);
        overflow: hidden;
        background: var(--bg-secondary);
        margin-bottom: 1rem;
      }
      .np-art {
        width: 100%;
        aspect-ratio: 1;
        object-fit: cover;
        display: block;
      }
      .np-placeholder {
        width: 100%;
        aspect-ratio: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-hint);
        font-size: 3rem;
      }
      .np-info { padding: 1rem; }
      .np-track { font-size: 1.1rem; font-weight: 700; }
      .np-artist { font-size: 0.9rem; color: var(--text-secondary); }
      .np-album { font-size: 0.82rem; color: var(--text-hint); margin-top: 0.15rem; }
      .np-source { margin-top: 0.35rem; }

      /* ---- Playback controls ---- */
      .playback-controls {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 1rem;
        margin-bottom: 1rem;
      }
      .ctrl-btn {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: 1px solid var(--border-color);
        background: var(--bg-secondary);
        font-size: 1.1rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all var(--transition);
      }
      .ctrl-btn:hover { box-shadow: var(--shadow-sm); }
      .ctrl-btn:active { transform: scale(0.94); }
      .ctrl-btn-lg { width: 52px; height: 52px; font-size: 1.4rem; }

      /* ---- Volume ---- */
      .vol-row {
        padding: 0.55rem 0;
        border-bottom: 1px solid var(--border-light);
      }
      .vol-row:last-child { border-bottom: none; }
      .vol-name { font-size: 0.82rem; font-weight: 600; display: block; margin-bottom: 0.25rem; }
      .vol-controls { display: flex; align-items: center; gap: 0.5rem; }
      .vol-controls input[type="range"] { flex: 1; accent-color: var(--accent); }
      .vol-label {
        font-size: 0.82rem; font-weight: 600;
        min-width: 2.2rem; text-align: center;
        font-family: var(--font-mono);
      }
      .mute-btn {
        background: none; border: none;
        font-size: 1.1rem; cursor: pointer;
        padding: 0.15rem; border-radius: 4px;
        transition: opacity var(--transition);
      }
      .mute-btn.muted { opacity: 0.5; }

      /* ---- Speaker chips ---- */
      .speaker-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-bottom: 1rem;
      }
      .chip {
        font-family: inherit;
        font-size: 0.78rem;
        padding: 0.3rem 0.7rem;
        border-radius: 999px;
        border: 1px solid var(--border-color);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        cursor: pointer;
        transition: all var(--transition);
      }
      .chip.active {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }

      /* ---- Section title ---- */
      .section-title {
        font-size: 0.82rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        margin-bottom: 0.6rem;
      }

      /* ---- Badges ---- */
      .badge {
        display: inline-block;
        font-size: 0.68rem;
        font-weight: 600;
        padding: 0.15rem 0.45rem;
        border-radius: 999px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: #fff;
        background: var(--text-hint);
      }
      .badge-spotify { background: var(--badge-spotify); }
      .badge-tunein { background: var(--badge-tunein); }
      .badge-radio { background: var(--badge-radio); }
      .badge-product { background: var(--badge-product); }

      /* ---- Preset grid ---- */
      .preset-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.65rem;
        margin-bottom: 1rem;
      }
      .preset-card {
        font-family: inherit;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        padding: 0.6rem;
        cursor: pointer;
        text-align: center;
        transition: all var(--transition);
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.35rem;
        min-height: 100px;
      }
      .preset-card:hover { box-shadow: var(--shadow-md); border-color: var(--accent); }
      .preset-card.playing { border-color: var(--accent); background: var(--accent-light); }
      .preset-num {
        position: absolute;
        top: 4px; left: 4px;
        background: var(--accent);
        color: #fff;
        font-size: 0.65rem;
        font-weight: 700;
        width: 18px; height: 18px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .preset-art {
        width: 64px; height: 64px;
        border-radius: var(--radius-sm);
        object-fit: cover;
        background: var(--bg-primary);
      }
      .preset-art-ph {
        width: 64px; height: 64px;
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.5rem;
        font-weight: 700;
        color: var(--text-hint);
      }
      .preset-name {
        font-size: 0.78rem;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
      }
      .preset-src { margin-top: 0.1rem; }
      .preset-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-bottom: 0.5rem;
      }

      /* ---- Preset edit ---- */
      .edit-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 1rem;
      }
      .back-btn {
        font-size: 1.3rem;
        color: var(--text-secondary);
        cursor: pointer;
        background: none;
        border: none;
        padding: 0.25rem;
        transition: color var(--transition);
      }
      .back-btn:hover { color: var(--accent); }
      .edit-title { font-size: 1.1rem; font-weight: 700; }
      .edit-choices { text-align: center; }
      .existing-preset-info {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.4rem;
        margin-bottom: 1rem;
      }
      .edit-thumb {
        width: 80px; height: 80px;
        border-radius: var(--radius-sm);
        object-fit: cover;
      }
      .btn-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        justify-content: center;
        margin-top: 0.75rem;
      }

      /* ---- TuneIn search ---- */
      .search-section { margin-top: 0.5rem; }
      .search-bar {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 0.75rem;
      }
      .search-bar input {
        flex: 1;
        padding: 0.5rem 0.75rem;
        font-size: 0.85rem;
        font-family: inherit;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        outline: none;
      }
      .search-bar input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px var(--accent-light);
      }
      .search-results { max-height: 300px; overflow-y: auto; }
      .tunein-detail {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        padding: 1rem 0;
      }
      .tunein-detail-img {
        width: 80px; height: 80px;
        border-radius: var(--radius-sm);
        object-fit: cover;
      }
      .tunein-detail-name { font-weight: 700; font-size: 1rem; }

      /* ---- Radio form ---- */
      .radio-form { }
      .form-group { margin-bottom: 0.85rem; }
      .form-group label {
        display: block;
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--text-secondary);
        margin-bottom: 0.25rem;
      }
      .form-group input {
        width: 100%;
        padding: 0.5rem 0.75rem;
        font-size: 0.85rem;
        font-family: inherit;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        outline: none;
      }
      .form-group input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px var(--accent-light);
      }

      /* ---- Remote grid ---- */
      .remote-grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 0.5rem;
        max-width: 320px;
        margin: 0 auto;
      }
      .remote-grid .btn { height: 52px; font-size: 0.88rem; }
      .remote-full { grid-column: 1 / -1; }

      /* ---- List items (recents & search results) ---- */
      .list-item {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.6rem 0;
        border-bottom: 1px solid var(--border-light);
        cursor: pointer;
        transition: background var(--transition);
      }
      .list-item:last-child { border-bottom: none; }
      .list-item:hover { background: var(--accent-light); }
      .list-thumb {
        width: 48px; height: 48px;
        border-radius: var(--radius-sm);
        object-fit: cover;
        background: var(--bg-secondary);
        flex-shrink: 0;
      }
      .list-thumb-ph {
        width: 48px; height: 48px;
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.2rem;
        color: var(--text-hint);
        flex-shrink: 0;
      }
      .list-body { flex: 1; min-width: 0; }
      .list-title {
        font-weight: 600;
        font-size: 0.85rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .list-sub {
        font-size: 0.75rem;
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* ---- Buttons ---- */
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        padding: 0.5rem 1rem;
        font-size: 0.85rem;
        font-weight: 500;
        font-family: inherit;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        cursor: pointer;
        transition: all var(--transition);
        white-space: nowrap;
      }
      .btn:hover { box-shadow: var(--shadow-sm); }
      .btn:active { transform: scale(0.97); }
      .btn-sm { padding: 0.3rem 0.65rem; font-size: 0.78rem; }
      .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
      .btn-primary:hover { background: var(--accent-hover); }
      .btn-danger { background: var(--danger); color: #fff; border-color: var(--danger); }

      /* ---- Misc ---- */
      .text-muted { color: var(--text-secondary); font-size: 0.85rem; }
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 2rem 1rem;
        text-align: center;
        color: var(--text-hint);
        gap: 0.75rem;
      }
      .spinner {
        width: 28px; height: 28px;
        border: 3px solid var(--border-color);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
        margin: 1.5rem auto;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    `;
  }
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

customElements.define("soundcork-card", SoundCorkCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "soundcork-card",
  name: "SoundCork",
  description: "Control Bose SoundTouch speakers via SoundCork",
  preview: true,
});
