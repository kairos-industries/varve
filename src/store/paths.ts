import { join } from "node:path";
import { parsePeriod, rangeOf } from "../time/index.js";

export class AtlasPaths {
  constructor(readonly root: string) {}

  get stateDir() {
    return join(this.root, ".atlas");
  }
  get scopesFile() {
    return join(this.stateDir, "scopes.json");
  }
  get sessionsFile() {
    return join(this.stateDir, "sessions.json");
  }
  get locksDir() {
    return join(this.stateDir, "locks");
  }
  scopesRoot() {
    return join(this.root, "scopes");
  }
  scopeDir(scope: string) {
    return join(this.root, "scopes", scope);
  }
  sessionsDir(scope: string) {
    return join(this.scopeDir(scope), "sessions");
  }
  sessionNote(scope: string, startDay: string, startTime: string, id: string) {
    const [y, m] = startDay.split("-");
    return join(this.sessionsDir(scope), y!, m!, `${startDay}T${startTime.replace(":", "")}-${id}.md`);
  }
  periodNote(scope: string, period: string) {
    return join(this.scopeDir(scope), periodSubpath(period), `${period} ${scope}.md`);
  }
  indexNote(period: string) {
    return join(this.root, "index", periodSubpath(period), `${period}.md`);
  }
  topicsDir(scope: string) {
    return join(this.scopeDir(scope), "topics");
  }
  topicNote(scope: string, name: string) {
    return join(this.topicsDir(scope), `${name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim()}.md`);
  }
}

function periodSubpath(period: string): string {
  const { layer } = parsePeriod(period);
  const year = layer === "week" ? period.slice(0, 4) : rangeOf(period).first.slice(0, 4);
  switch (layer) {
    case "day":
      return join("days", year);
    case "week":
      return join("weeks", year);
    case "month":
      return join("months", year);
    case "year":
      return "years";
  }
}
