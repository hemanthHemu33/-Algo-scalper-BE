const EventEmitter = require("events");

class MarketGate extends EventEmitter {
  constructor({ isOpenFn, pollMs = 5000 } = {}) {
    super();
    this.isOpenFn = isOpenFn;
    this.pollMs = pollMs;
    this._isOpen = null;
    this._timer = null;
  }

  start() {
    const tick = () => {
      const nowOpen = !!this.isOpenFn?.();
      if (this._isOpen === null) this._isOpen = nowOpen;

      if (nowOpen !== this._isOpen) {
        this._isOpen = nowOpen;
        this.emit(nowOpen ? "open" : "close");
      }
    };

    tick();
    this._timer = setInterval(tick, this.pollMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  isOpen() {
    return !!this._isOpen;
  }
}

module.exports = { MarketGate };
