export function createControls(callbacks) {
  const first = document.getElementById("btn-first");
  const back = document.getElementById("btn-back");
  const next = document.getElementById("btn-next");
  const last = document.getElementById("btn-last");
  const play = document.getElementById("btn-play");
  const counter = document.getElementById("counter");
  const speed = document.getElementById("speed");

  let playing = false;
  let timer = null;
  let hasSteps = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stop() {
    playing = false;
    play.textContent = "Lecture";
    play.classList.remove("active");
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
    if (hasSteps) {
      stop();
      callbacks.onFirst();
    }
  });
  back.addEventListener("click", () => {
    if (hasSteps) {
      stop();
      callbacks.onBack();
    }
  });
  next.addEventListener("click", () => {
    if (hasSteps) {
      stop();
      callbacks.onNext();
    }
  });
  last.addEventListener("click", () => {
    if (hasSteps) {
      stop();
      callbacks.onLast();
    }
  });
  play.addEventListener("click", () => {
    if (!hasSteps) return;
    if (playing) {
      stop();
    } else {
      playing = true;
      play.textContent = "Pause";
      play.classList.add("active");
      const done = callbacks.onAutoStep();
      if (!done) schedule();
      else stop();
    }
  });

  return {
    setSteps(count, current) {
      hasSteps = count > 0;
      counter.textContent = hasSteps ? `${current + 1} / ${count}` : "0 / 0";
      first.disabled = back.disabled = !hasSteps || current <= 0;
      next.disabled = last.disabled = !hasSteps || current >= count - 1;
      if (!hasSteps) stop();
    },
    stop,
  };
}
