// The browser's voice and ears, faked, before the simulator's page loads.
//
// Speaking: headless browsers have no voice, and Chrome's onend can't be
// counted on, so an utterance starts and ends after a moment, as a real one
// does, and what was said is kept in window.e2eSaid.
//
// Listening: recognition needs a microphone, so a stand-in takes its place.
// window.e2eListens counts each time listening starts, and
// window.e2eHear(words) delivers a phrase the way Chrome does when it isn't
// listening continuously: a final result, then the end of the session.
(() => {
  const said = [];
  const pending = new Set();
  const later = (ms, then) => {
    const timer = setTimeout(() => {
      pending.delete(timer);
      then();
    }, ms);
    pending.add(timer);
  };
  window.e2eSaid = said;
  speechSynthesis.speak = (utterance) => {
    said.push(utterance.text);
    later(50, () => {
      utterance.dispatchEvent(new Event("start"));
      later(250, () => utterance.dispatchEvent(new Event("end")));
    });
  };
  speechSynthesis.cancel = () => {
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
  };

  let current = null;
  window.e2eListens = 0;
  function FakeRecognition() {
    this.lang = "";
    this.continuous = false;
    this.interimResults = false;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
  }
  FakeRecognition.prototype.start = function () {
    window.e2eListens++;
    current = this;
  };
  FakeRecognition.prototype.stop = function () {
    if (current !== this) return;
    current = null;
    setTimeout(() => this.onend?.(), 0);
  };
  window.e2eHear = (words) => {
    const recognition = current;
    if (!recognition) throw new Error(`Nothing is listening to hear "${words}".`);
    current = null;
    const result = Object.assign([{ transcript: words, confidence: 1 }], { isFinal: true });
    recognition.onresult?.({ resultIndex: 0, results: [result] });
    recognition.onend?.();
  };
  for (const name of ["SpeechRecognition", "webkitSpeechRecognition"]) {
    Object.defineProperty(window, name, { value: FakeRecognition, configurable: true, writable: true });
  }
})();
