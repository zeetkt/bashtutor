export function createControls(callbacks) {
  const first = document.getElementById("btn-first");
  const back = document.getElementById("btn-back");
  const next = document.getElementById("btn-next");
  const last = document.getElementById("btn-last");
  const play = document.getElementById("btn-play");
  const counter = document.getElementById("counter");
  const speed = document.getElementById("speed");
  const scrubber = document.getElementById("scrubber");

  let playing = false;
  let timer = null;
  let hasSteps = false;
  let current = 0;
  let count = 0;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function setPlaying(value) {
    playing = value;
    play.textContent = value ? "Pause" : "Lecture";
    play.classList.toggle("active", value);
    play.setAttribute("aria-pressed", String(value));
  }

  function stop() {
    setPlaying(false);
    clearTimer();
  }

  function schedule() {
    if (!playing || !hasSteps) return;
    clearTimer();
    timer = setTimeout(() => {
      const done = callbacks.onAutoStep();
      if (!done) schedule();
      else stop();
    }, Number(speed.value));
  }

  first.addEventListener("click", () => {
    if (!hasSteps) return;
    stop();
    callbacks.onFirst();
  });
  back.addEventListener("click", () => {
    if (!hasSteps) return;
    stop();
    callbacks.onBack();
  });
  next.addEventListener("click", () => {
    if (!hasSteps) return;
    stop();
    callbacks.onNext();
  });
  last.addEventListener("click", () => {
    if (!hasSteps) return;
    stop();
    callbacks.onLast();
  });
  play.addEventListener("click", () => {
    if (!hasSteps) return;
    if (playing) {
      stop();
      return;
    }
    if (current >= count - 1) callbacks.onFirst();
    setPlaying(true);
    const done = callbacks.onAutoStep();
    if (!done) schedule();
    else stop();
  });

  scrubber.addEventListener("input", () => {
    if (!hasSteps) return;
    stop();
    callbacks.onSeek(Number(scrubber.value));
  });

  return {
    setSteps(total, position) {
      count = total;
      current = position;
      hasSteps = total > 0;
      counter.textContent = hasSteps ? `${position + 1} / ${total}` : "0 / 0";
      first.disabled = back.disabled = !hasSteps || position <= 0;
      next.disabled = last.disabled = !hasSteps || position >= total - 1;
      scrubber.max = String(Math.max(0, total - 1));
      scrubber.value = String(Math.max(0, position));
      scrubber.disabled = !hasSteps;
      if (!hasSteps) stop();
    },
    stop,
  };
}
