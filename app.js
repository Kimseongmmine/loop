"use strict";

// ---- storage ----
const STORE_KEY = "loop.days";

function loadDays() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveDays(days) {
  localStorage.setItem(STORE_KEY, JSON.stringify(days));
}

function getDay(days, date) {
  return days.find(function (d) { return d.date === date; }) || null;
}

function upsertDay(day) {
  const days = loadDays();
  const i = days.findIndex(function (d) { return d.date === day.date; });
  if (i >= 0) days[i] = day; else days.push(day);
  saveDays(days);
  return day;
}

// most recent record strictly before the given date (by date string)
function mostRecentBefore(days, date) {
  const past = days
    .filter(function (d) { return d.date < date; })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  return past[0] || null;
}

// ---- date helpers (local time) ----
function pad2(n) { return n < 10 ? "0" + n : "" + n; }

function dateStr(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function todayStr() { return dateStr(new Date()); }

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return dateStr(d);
}

// ---- screen dispatch ----
// 21:00–03:59 -> night, 04:00–20:59 -> morning
function currentScreen() {
  const h = new Date().getHours();
  return (h >= 21 || h < 4) ? "night" : "morning";
}

function render() {
  const root = document.getElementById("screen");
  root.innerHTML = "";
  if (currentScreen() === "night") renderNight(root);
  else renderMorning(root);
}

// ---- stubs (filled in later steps) ----
function renderNight(root) {
  root.textContent = "night";
}

function renderMorning(root) {
  root.textContent = "morning";
}

render();
