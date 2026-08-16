// Runs the four-arm grid and prints the results table used in the README.
import { runExperiment, welch } from "../js/sim/runner.js";
const res = runExperiment(8, { demand: 0.9 });
const f = (a) => `${a.mean.toFixed(1)} ± ${a.sd.toFixed(1)}`;
console.log("| Arm | EV travel time (s) | Delay vs free-flow (s) | Impedances | Mean speed (km/h) | Zone length (m) | Lane-1 vehicles slowed |");
console.log("|---|---|---|---|---|---|---|");
for (const r of res) {
  console.log(`| ${r.label} | ${f(r.travel)} | ${f(r.delay)} | ${r.slowdowns.mean.toFixed(1)} | ${r.meanSpeed.mean.toFixed(1)} | ${r.zoneLength.mean > 0 ? r.zoneLength.mean.toFixed(0) : "—"} | ${r.vslVehicles.mean.toFixed(0)} |`);
}
const base = res[0].travel, best = res[3].travel;
const t = welch(base, best);
console.log("");
console.log(`improvement ${(100*(base.mean-best.mean)/base.mean).toFixed(1)}%  t=${t.t.toFixed(2)} df=${t.df.toFixed(1)} significant=${t.significant}`);
console.log(`lane-only vs today: ${(100*(base.mean-res[1].travel.mean)/base.mean).toFixed(1)}%`);
console.log(`adaptive vs fixed zone VSL cost: ${res[2].vslVehicles.mean.toFixed(0)} -> ${res[3].vslVehicles.mean.toFixed(0)} vehicles`);

