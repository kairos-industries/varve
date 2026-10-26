import { join } from "node:path";
import { parsePeriod, rangeOf } from "../time/index.js";
export class AtlasPaths {
    root;
    constructor(root) {
        this.root = root;
    }
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
    get captureDir() {
        return join(this.stateDir, "capture");
    }
    /** Capture progress for one client session: how far its transcript has been read. */
    captureFile(clientSessionId) {
        return join(this.captureDir, `${clientSessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    }
    /** Cross-process mutex key for one note, kept out of the vault folders. */
    noteMutex(notePath) {
        return join(this.stateDir, "mutex", notePath.slice(this.root.length + 1).replace(/[\\/]/g, "__"));
    }
    get tidyLog() {
        return join(this.stateDir, "tidy.log");
    }
    /** When the nightly schedule was installed and when it last ran. */
    get nightlyFile() {
        return join(this.stateDir, "nightly.json");
    }
    scopesRoot() {
        return join(this.root, "scopes");
    }
    scopeDir(scope) {
        return join(this.root, "scopes", scope);
    }
    sessionsDir(scope) {
        return join(this.scopeDir(scope), "sessions");
    }
    sessionNote(scope, startDay, startTime, id) {
        const [y, m] = startDay.split("-");
        return join(this.sessionsDir(scope), y, m, `${startDay}T${startTime.replace(":", "")}-${id}.md`);
    }
    periodNote(scope, period) {
        return join(this.scopeDir(scope), periodSubpath(period), `${period} ${scope}.md`);
    }
    indexNote(period) {
        return join(this.root, "index", periodSubpath(period), `${period}.md`);
    }
    topicsDir(scope) {
        return join(this.scopeDir(scope), "topics");
    }
    topicNote(scope, name) {
        return join(this.topicsDir(scope), `${name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim()}.md`);
    }
}
function periodSubpath(period) {
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
