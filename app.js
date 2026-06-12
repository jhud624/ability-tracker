const demoVideos = {
  "tibialis raise": "boFuKPm5w2Q",
  "atg split squat": "qfpkwZlG-cs",
  "elephant walk": "VftyiSAcfEI",
  "pigeon": "2msg4jdu0vk",
  "pigeon stretch": "2msg4jdu0vk",
  "couch stretch": "7bW0dBwB7Dc",
  "active couch stretch": "7bW0dBwB7Dc",
  "seated goodmorning": "k2gpUHdRXS4",
  "ql extension": "Kzmdyvlwocc",
  "trap-3 raise": "AlixeUG_bIU",
  "garhammer raise": "5ofUYbge_hg",
  "patrick step down": "jAbO12BipQU",
  "back extension progression": "3jHiRIKo7VQ"
};

const workouts = [
  {
    id: "back-week-2-checklist",
    area: "back",
    shortName: "Week 2 checklist",
    name: "Back Ability: Week 2",
    day: "Exercise checklist",
    description: "A full-body back ability sequence with mobility, trunk strength, and lower-body range work.",
    exercises: [
      ["A", "1 set", "Backward Walking", "Walk backwards for 5 minutes"],
      ["B", "Sets not visible", "Tibialis Raise", "25 reps"],
      ["C", "Sets not visible", "Split Squat Stretch", "30 seconds per side"],
      ["D", "Sets not visible", "Back Extension Progression", "1 minute"],
      ["E", "Sets not visible", "Seated Goodmorning", "25 reps"],
      ["F", "Sets not visible", "Pigeon", "20 reps per side"],
      ["G", "Sets not visible", "Hamstring Stretch", "Pulse for 15 reps per side"],
      ["H", "Sets not visible", "L-Sit", "15 reps per side"],
      ["I", "Sets not visible", "QL Extension", "15 reps per side"],
      ["J", "Sets not visible", "Wall Pullover", "15 reps"],
      ["K", "Sets not visible", "Trap-3 Raise", "15 reps"],
      ["L", "Sets not visible", "Couch Stretch", "1 minute per side"]
    ]
  },
  {
    id: "back-week-2-monday",
    area: "back",
    shortName: "Week 2 Monday",
    name: "Back Ability: Week 2 Monday",
    day: "Monday routine",
    description: "A gym-based session pairing backward work, lower-leg strength, hip mobility, and shoulder control.",
    exercises: [
      ["A", "2 sets", "Sled or Resisted Treadmill", "Backward 60 yards or 1 minute"],
      ["A", "2 sets", "Sled or Resisted Treadmill", "Forward 30 yards or 30 seconds"],
      ["B", "1 set", "Calf Stretch", "1 minute per side on slantboard"],
      ["C", "2 sets", "Tibialis Raise", "Use Tib Bar for 12-15 reps"],
      ["C", "2 sets", "Seated Calf Raise", "Use dumbbell or kettlebell for 15-20 reps"],
      ["D", "3 sets", "ATG Split Squat", "10-12 reps per side"],
      ["D", "3 sets", "Seated Goodmorning", "12-15 reps with dumbbells"],
      ["E", "1 set", "Couch Stretch", "1 minute per side"],
      ["E", "1 set", "Piriformis Push Up", "20 reps per side"],
      ["E", "1 set", "Pancake", "Standing pulse, 20 reps"],
      ["E", "1 set", "Elephant Walk", "20 reps per side"],
      ["F", "2 sets", "External Rotation", "10-12 reps per side"],
      ["F", "2 sets", "Pullover", "10-12 reps"],
      ["F", "2 sets", "Trap-3 Raise", "5 eccentric reps"]
    ]
  },
  {
    id: "back-ground-up",
    area: "back",
    shortName: "Ground-up",
    name: "Ground-Up Approach",
    day: "Monday routine",
    description: "Start at the feet and hips, then build toward loaded hip and back capacity.",
    exercises: [
      ["A", "1 set", "Sled", "Backwards for 5 minutes"],
      ["B", "2 sets", "Calf Stretch", "1 minute per side on slantboard"],
      ["B", "2 sets", "Tibialis Raise", "20 reps"],
      ["C", "2 sets", "Pigeon", "20 reps per side"],
      ["D", "2 sets", "Seated Goodmorning", "15 reps"],
      ["E", "3 sets", "ATG Split Squat", "5 reps per side"]
    ]
  },
  {
    id: "back-top-down",
    area: "back",
    shortName: "Top-down",
    name: "Top-Down Approach",
    day: "Tuesday routine",
    description: "Shoulder, trunk, and hip work that finishes with direct back extension strength.",
    exercises: [
      ["A", "2 sets", "Pullover", "5 reps"],
      ["A", "2 sets", "Trap-3 Raise", "6 reps"],
      ["B", "2 sets", "QL Extension", "10 reps per side"],
      ["B", "2 sets", "Hip Flexors", "20 reps"],
      ["C", "Sets not visible", "Back Extension Progression", "12 reps"]
    ]
  },
  {
    id: "knee-routine-monday",
    area: "knee",
    shortName: "Ability routine",
    name: "Knee Ability Routine",
    day: "Monday routine",
    description: "A bodyweight-first sequence for ankles, calves, knees, hips, and hamstrings.",
    exercises: [
      ["A", "1 set", "Backward Walking", "Walk backwards for 5 minutes"],
      ["B", "1 set", "Tibialis Raise", "20 reps"],
      ["C", "1 set", "Straight Leg Calf Raise", "Up to 25 reps"],
      ["D", "1 set", "Bent Leg Calf Raise", "Up to 25 reps"],
      ["E", "2 sets", "Patrick Step Down", "25 reps per side"],
      ["F", "3 sets", "ATG Split Squat", "Up to 10 reps per side"],
      ["G", "1 set", "Elephant Walk", "20 reps per side"],
      ["G", "1 set", "L-Sit", "20 reps or 20-second hold"],
      ["G", "1 set", "Active Couch Stretch", "Up to 45 seconds per side"],
      ["G", "1 set", "Piriformis Push-up", "20 reps per side"],
      ["G", "1 set", "Standing Pancake Pulse", "20 reps"]
    ]
  },
  {
    id: "knee-workout-a",
    area: "knee",
    shortName: "Workout A",
    name: "Knee Ability Workout A",
    day: "Monday routine",
    description: "A longer strength session with calf, step-down, squat, hamstring, core, and mobility work.",
    exercises: [
      ["A", "1 set", "ATG Warm-up", "100 yards, forward and backward"],
      ["B", "1 set", "Tibialis Raise", "20 reps"],
      ["C", "2 sets", "Single-Leg Calf Raise", "To failure"],
      ["D", "2 sets", "Step Down Progression", "20 reps per side"],
      ["E", "3 sets", "ATG Split Squat", "10 reps per side"],
      ["F", "3 sets", "Slow-Eccentric Front Squat", "5 reps"],
      ["G", "2 sets", "Ham Roller", "10 reps"],
      ["G", "2 sets", "Garhammer Raise", "To failure"],
      ["H", "2 sets", "Pigeon Stretch", "30 seconds per side"],
      ["H", "2 sets", "Standing Pancake", "30 seconds"]
    ]
  }
].map((workout) => ({
  ...workout,
  exercises: workout.exercises.map(([block, sets, name, prescription], index) => ({
    id: `${workout.id}-${index}`,
    block,
    sets,
    name,
    prescription
  }))
}));

const state = {
  area: "back",
  workoutId: "back-week-2-checklist",
  completed: new Set()
};

const elements = {
  today: document.querySelector("#today-label"),
  areaButtons: [...document.querySelectorAll(".area-button")],
  programStrip: document.querySelector("#program-strip"),
  workoutKicker: document.querySelector("#workout-kicker"),
  workoutName: document.querySelector("#workout-name"),
  workoutDescription: document.querySelector("#workout-description"),
  exerciseList: document.querySelector("#exercise-list"),
  progressRing: document.querySelector("#progress-ring"),
  progressPercent: document.querySelector("#progress-percent"),
  progressCount: document.querySelector("#progress-count"),
  progressBar: document.querySelector("#progress-bar"),
  completeCard: document.querySelector("#complete-card"),
  resetButton: document.querySelector("#reset-button"),
  demoDialog: document.querySelector("#demo-dialog"),
  demoTitle: document.querySelector("#demo-title"),
  demoContent: document.querySelector("#demo-content"),
  youtubeLink: document.querySelector("#youtube-link"),
  closeDemo: document.querySelector("#close-demo"),
  dialogDone: document.querySelector("#dialog-done")
};

function currentWorkout() {
  return workouts.find((workout) => workout.id === state.workoutId);
}

function videoFor(name) {
  const normalized = name.toLowerCase();
  return demoVideos[normalized] || null;
}

function youtubeSearch(name) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} ATG Knees Over Toes Guy`)}`;
}

function renderPrograms() {
  const available = workouts.filter((workout) => workout.area === state.area);
  elements.programStrip.innerHTML = available.map((workout) => `
    <button class="program-button ${workout.id === state.workoutId ? "is-active" : ""}"
      type="button" data-workout="${workout.id}">${workout.shortName}</button>
  `).join("");
}

function renderWorkout() {
  const workout = currentWorkout();
  elements.workoutKicker.textContent = workout.day;
  elements.workoutName.textContent = workout.name;
  elements.workoutDescription.textContent = workout.description;

  let lastBlock = null;
  const pieces = [];
  workout.exercises.forEach((exercise) => {
    if (exercise.block !== lastBlock) {
      pieces.push(`<div class="block-label">Block ${exercise.block}</div>`);
      lastBlock = exercise.block;
    }
    const isDone = state.completed.has(exercise.id);
    pieces.push(`
      <article class="exercise-card ${isDone ? "is-done" : ""}" data-exercise-card="${exercise.id}">
        <button class="check-button" type="button" data-check="${exercise.id}"
          aria-label="${isDone ? "Mark incomplete" : "Mark complete"}: ${exercise.name}"
          aria-pressed="${isDone}"></button>
        <div class="exercise-info">
          <strong><span class="mobile-block" aria-hidden="true">${exercise.block}</span>${exercise.name}</strong>
          <p><span class="sets-tag">${exercise.sets}</span>${exercise.prescription}</p>
        </div>
        <button class="demo-button" type="button" data-demo="${exercise.id}" aria-label="View ATG demo for ${exercise.name}">Demo</button>
      </article>
    `);
  });
  elements.exerciseList.innerHTML = pieces.join("");
  renderProgress();
}

function renderProgress() {
  const workout = currentWorkout();
  const completed = workout.exercises.filter((exercise) => state.completed.has(exercise.id)).length;
  const total = workout.exercises.length;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressCount.textContent = `${completed} of ${total}`;
  elements.progressRing.style.setProperty("--progress", `${percent * 3.6}deg`);
  elements.progressBar.style.width = `${percent}%`;
  elements.completeCard.hidden = percent !== 100;
}

function selectArea(area) {
  state.area = area;
  const firstWorkout = workouts.find((workout) => workout.area === area);
  state.workoutId = firstWorkout.id;
  elements.areaButtons.forEach((button) => {
    const active = button.dataset.area === area;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderPrograms();
  renderWorkout();
}

function toggleExercise(id) {
  if (state.completed.has(id)) state.completed.delete(id);
  else state.completed.add(id);
  renderWorkout();
}

function openDemo(exerciseId) {
  const workout = currentWorkout();
  const exercise = workout.exercises.find((item) => item.id === exerciseId);
  const videoId = videoFor(exercise.name);
  const externalUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : youtubeSearch(exercise.name);
  elements.demoTitle.textContent = exercise.name;
  elements.youtubeLink.href = externalUrl;

  if (videoId) {
    elements.demoContent.innerHTML = `
      <div class="video-frame">
        <iframe
          src="https://www.youtube-nocookie.com/embed/${videoId}"
          title="${exercise.name} exercise demonstration"
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen></iframe>
      </div>`;
  } else {
    elements.demoContent.innerHTML = `
      <div class="search-demo">
        <div>
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="46" fill="#fffefa" />
            <path d="M38 28 L72 50 L38 72 Z" fill="#ff6b45" />
          </svg>
          <p>No single verified embed is selected for this variation. Open a focused ATG / Knees Over Toes Guy search and choose the closest demonstration for your equipment and ability level.</p>
        </div>
      </div>`;
  }
  elements.demoDialog.showModal();
}

elements.today.textContent = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric"
}).format(new Date());

elements.areaButtons.forEach((button) => {
  button.addEventListener("click", () => selectArea(button.dataset.area));
});

elements.programStrip.addEventListener("click", (event) => {
  const button = event.target.closest("[data-workout]");
  if (!button) return;
  state.workoutId = button.dataset.workout;
  renderPrograms();
  renderWorkout();
});

elements.exerciseList.addEventListener("click", (event) => {
  const demo = event.target.closest("[data-demo]");
  if (demo) {
    openDemo(demo.dataset.demo);
    return;
  }
  const check = event.target.closest("[data-check]");
  if (check) {
    toggleExercise(check.dataset.check);
    return;
  }
  const card = event.target.closest("[data-exercise-card]");
  if (card) toggleExercise(card.dataset.exerciseCard);
});

elements.resetButton.addEventListener("click", () => {
  currentWorkout().exercises.forEach((exercise) => state.completed.delete(exercise.id));
  renderWorkout();
});

function closeDialog() {
  elements.demoDialog.close();
  elements.demoContent.innerHTML = "";
}

elements.closeDemo.addEventListener("click", closeDialog);
elements.dialogDone.addEventListener("click", closeDialog);
elements.demoDialog.addEventListener("click", (event) => {
  if (event.target === elements.demoDialog) closeDialog();
});
elements.demoDialog.addEventListener("close", () => {
  elements.demoContent.innerHTML = "";
});

renderPrograms();
renderWorkout();
