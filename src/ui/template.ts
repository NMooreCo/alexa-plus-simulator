/** The simulator's markup, rendered into its root. Fixed text only: everything that varies is set as text afterward. */
export const TEMPLATE = `
<div class="layout">
  <section class="stage" aria-label="Simulated device">
    <div class="stage-bar">
      <label>Device <select id="device-pick"></select></label>
      <label>Screen theme <select id="theme"><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <span class="surface" id="surface"></span>
    </div>
    <p class="device-label" id="device-label" hidden><strong id="device-place"></strong> <span id="device-model"></span></p>
    <div class="device" id="device">
      <div class="screen" id="screen">
        <div class="idle" id="idle">
          <div class="idle-clock" id="idle-clock"></div>
          <div class="idle-hint" id="idle-hint"></div>
        </div>
        <div class="app-host" id="app-host"></div>
        <div class="screen-slot" id="slot-screen"></div>
        <div class="caption" id="caption" hidden>
          <p class="heard" id="heard"></p>
          <p class="said" id="said"></p>
        </div>
        <div class="lightbar" id="lightbar" data-state="idle"></div>
      </div>
      <div class="device-slot" id="slot-device"></div>
    </div>
    <p class="device-note" id="device-note"></p>
  </section>

  <aside class="panel">
    <header>
      <h1 id="title"></h1>
      <p class="lede" id="lede"></p>
      <div class="header-slot" id="slot-header"></div>
      <p class="status" id="status" role="status">Connecting...</p>
    </header>

    <div class="talk">
      <button type="button" class="mic" id="mic" aria-pressed="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" /></svg>
        <span id="mic-label">Talk</span>
      </button>
      <form class="ask" id="ask-form">
        <input id="ask-input" type="text" placeholder="Or type what you'd say" autocomplete="off" aria-label="What you'd say" />
        <button type="submit">Ask</button>
      </form>
      <label class="toggle"><input type="checkbox" id="handsfree" /> Hands-free: start with "Alexa"</label>
      <p class="note" id="voice-note"></p>
    </div>

    <div class="panel-slot" id="slot-panel"></div>

    <div class="chips" id="chips" aria-label="Things to try"></div>

    <nav class="tabs" role="tablist" aria-label="Simulator panels">
      <button type="button" role="tab" id="tab-conversation" aria-controls="panel-conversation" aria-selected="true">Conversation</button>
      <button type="button" role="tab" id="tab-traffic" aria-controls="panel-traffic" aria-selected="false">Traffic <span class="count" id="traffic-count"></span></button>
      <button type="button" role="tab" id="tab-tools" aria-controls="panel-tools" aria-selected="false">Tools</button>
      <button type="button" role="tab" id="tab-readiness" aria-controls="panel-readiness" aria-selected="false">Readiness</button>
      <button type="button" role="tab" id="tab-server" aria-controls="panel-server" aria-selected="false">Server</button>
    </nav>

    <section class="tab-panel" id="panel-conversation" role="tabpanel" aria-labelledby="tab-conversation">
      <p class="hint" id="model-note"></p>
      <ol class="log" id="talk-log"></ol>
    </section>

    <section class="tab-panel" id="panel-traffic" role="tabpanel" aria-labelledby="tab-traffic" hidden>
      <p class="hint" id="budget-note"></p>
      <ol class="log traffic" id="traffic-log"></ol>
    </section>

    <section class="tab-panel" id="panel-tools" role="tabpanel" aria-labelledby="tab-tools" hidden>
      <p class="hint">Call any tool yourself, no model needed. A tool with a screen shows it on the device.</p>
      <label class="field">Tool <select id="tool-pick"></select></label>
      <p class="tool-about" id="tool-about"></p>
      <label class="field">Arguments (JSON) <textarea id="tool-args" rows="6" spellcheck="false"></textarea></label>
      <div class="row">
        <button type="button" id="tool-call">Call</button>
        <span class="meta" id="tool-meta"></span>
      </div>
      <pre class="result" id="tool-result" hidden></pre>
    </section>

    <section class="tab-panel" id="panel-readiness" role="tabpanel" aria-labelledby="tab-readiness" hidden>
      <p class="hint" id="check-about"></p>
      <div class="row">
        <button type="button" id="check-run">Run the readiness check</button>
        <button type="button" id="check-save" hidden>Save readiness-report.json</button>
      </div>
      <div id="check-report"></div>
    </section>

    <section class="tab-panel" id="panel-server" role="tabpanel" aria-labelledby="tab-server" hidden>
      <dl class="facts" id="server-facts"></dl>
      <h2>Instructions</h2>
      <pre class="result" id="server-instructions"></pre>
      <h2>Tools</h2>
      <ul class="tool-list" id="server-tools"></ul>
    </section>

    <footer>
      <button type="button" id="reset">New conversation</button>
      <button type="button" id="reconnect">Reconnect</button>
      <span class="footer-slot" id="slot-footer"></span>
    </footer>
  </aside>
</div>`;
