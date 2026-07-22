// Side-effect aggregate: register EVERY built-in tool. The CLI entry (index.ts) has always done these
// imports itself; library entries (serve/server.ts, future embedders) import THIS so the registry is
// never empty when runAgent plans a turn — an unregistered tool is silently unplannable, which shows up
// as "the model called write_file and nothing happened".
import "./builtin.js"; // read_file / write_file / python / bash / job
import "./runtime.js"; // tool_search / tool_result_read
import "./edit.js"; // edit_file
import "./search.js"; // grep / glob / ls
import "./patch.js"; // apply_patch
import "./web.js"; // web_search / web_fetch
import "./agent.js"; // agent (subagent spawn)
import "./memory.js"; // memory_search/get/write/forget + skill_create
import "./session-search.js"; // bounded cross-session transcript recall
import "./skill.js"; // skill loader
import "./codebase.js"; // codebase_search
import "./todo.js"; // todo_write
import "./task.js"; // task (project-level persistent task pool)
import "./send.js"; // send_file (self-gates on HARA_GATEWAY)
import "./external_agent.js"; // external_agent (claude-code / codex delegation)
import "./ask_user.js"; // ask_user
import "./cron.js"; // cronjob
import "./computer.js"; // computer (desktop control; self-gates on config)
