<?php
/**
 * Plugin Name: OSRS GitHub Agent
 * Description: Admin-only REST endpoints to propose (plan), generate (full file contents), and commit changes to a GitHub repo using OpenAI.
 * Version: 2.0.0
 */

if (!defined('ABSPATH')) exit;

/**
 * ROUTES
 */
add_action('rest_api_init', function () {

  register_rest_route('osrs-agent/v1', '/propose', [
    'methods' => 'POST',
    'permission_callback' => 'osrs_agent_permission_strict',
    'callback' => 'osrs_agent_propose',
  ]);

  register_rest_route('osrs-agent/v1', '/generate', [
  'methods' => 'POST',
  'permission_callback' => 'osrs_agent_permission_strict',
  'callback' => 'osrs_agent_generate',
]);

register_rest_route('osrs-agent/v1', '/generate-manual', [
  'methods' => 'POST',
  'permission_callback' => 'osrs_agent_permission_strict',
  'callback' => 'osrs_agent_generate_manual',
]);

  register_rest_route('osrs-agent/v1', '/commit', [
    'methods' => 'POST',
    'permission_callback' => 'osrs_agent_permission_strict',
    'callback' => 'osrs_agent_commit',
  ]);

  // Diagnostics (GET) — intended to be called from your UI (sends nonce)
  register_rest_route('osrs-agent/v1', '/diagnostics', [
    'methods' => 'GET',
    'permission_callback' => 'osrs_agent_permission_strict',
    'callback' => 'osrs_agent_diagnostics',
  ]);
});

/**
 * PERMISSIONS
 * Strict: admin capability + nonce header
 */
function osrs_agent_permission_strict(\WP_REST_Request $req) {
  $cap = defined('OSRS_AGENT_CAP') ? OSRS_AGENT_CAP : 'manage_options';
  if (!current_user_can($cap)) return false;

  $nonce = $req->get_header('X-WP-Nonce');
  return wp_verify_nonce($nonce, 'wp_rest');
}

function osrs_agent_cfg($key, $fallback = null) {
  return defined($key) ? constant($key) : $fallback;
}

function osrs_agent_allowed_files() {
  return ['index.html', 'style.css', 'script.js'];
}

function osrs_agent_format_wp_error($err) {
  if (!is_wp_error($err)) return null;
  return [
    'code' => $err->get_error_code(),
    'message' => $err->get_error_message(),
    'data' => $err->get_error_data(),
  ];
}

/**
 * GITHUB HELPERS
 */
function osrs_github_request($method, $path, $body = null, $query = []) {
  $owner  = osrs_agent_cfg('OSRS_GITHUB_OWNER');
  $repo   = osrs_agent_cfg('OSRS_GITHUB_REPO');
  $token  = osrs_agent_cfg('OSRS_GITHUB_TOKEN');
  $branch = osrs_agent_cfg('OSRS_GITHUB_BRANCH', 'main');

  if (!$owner || !$repo || !$token) {
    return new WP_Error('osrs_agent_cfg', 'Missing GitHub config in wp-config.php');
  }

  $url = "https://api.github.com/repos/{$owner}/{$repo}/contents/{$path}";
  if (!empty($query)) $url = add_query_arg($query, $url);

  $args = [
    'method'  => $method,
    'timeout' => 60,
    'redirection' => 3,
    'httpversion' => '1.1',
    'headers' => [
      'Authorization' => "Bearer {$token}",
      'Accept'        => 'application/vnd.github+json',
      'User-Agent'    => 'OSRS-WP-Agent',
    ],
  ];

  if ($body !== null) {
    $args['headers']['Content-Type'] = 'application/json';
    $args['body'] = wp_json_encode($body);
  }

  $res = wp_remote_request($url, $args);
  if (is_wp_error($res)) {
    return new WP_Error('osrs_github_http', 'GitHub request failed', osrs_agent_format_wp_error($res));
  }

  $code = wp_remote_retrieve_response_code($res);
  $raw  = wp_remote_retrieve_body($res);
  $json = json_decode($raw, true);

  if ($code < 200 || $code >= 300) {
    return new WP_Error('osrs_github_http', "GitHub HTTP {$code}", ['body' => $json ?: $raw]);
  }

  return $json;
}

function osrs_github_get_file($path) {
  $branch = osrs_agent_cfg('OSRS_GITHUB_BRANCH', 'main');
  return osrs_github_request('GET', $path, null, ['ref' => $branch]);
}

function osrs_github_update_file($path, $content_utf8, $sha, $message) {
  $branch = osrs_agent_cfg('OSRS_GITHUB_BRANCH', 'main');
  $payload = [
    'message' => $message,
    'content' => base64_encode($content_utf8),
    'branch'  => $branch,
    'sha'     => $sha,
  ];
  return osrs_github_request('PUT', $path, $payload);
}

/**
 * OPENAI HELPERS (2-stage)
 */
function osrs_openai_plan_only($instruction, $files_map) {
  $api_key = osrs_agent_cfg('OSRS_OPENAI_API_KEY');
  if (!$api_key) return new WP_Error('osrs_agent_cfg', 'Missing OpenAI key in wp-config.php');

  // Tighten scope (keeps output fast/small)
  $instruction =
    "Keep changes minimal and focused. Do not add new files. Only modify index.html, style.css, script.js if required.\n" .
    "Never omit file content. Do not use standalone ... lines anywhere.\n" .
    "Prefer client-side filtering over server/AJAX unless the user explicitly requires a backend endpoint.\n\n" .
    $instruction;

  $parts = [];
  foreach ($files_map as $path => $info) {
    $parts[] = "FILE: {$path}\n<<<\n{$info['content']}\n>>>";
  }
  $files_block = implode("\n\n", $parts);

$system = <<<SYS
You are a code editor.

Return ONLY a JSON plan (NO file contents).
Do NOT include Markdown fences.
Return a single JSON object only.

Format:
{
  "requirements_heard": "1-3 bullet sentences restating what the user wants",
  "plan": "short explanation of what you will change",
  "will_modify": {
    "index.html": true/false,
    "style.css": true/false,
    "script.js": true/false
  }
}
SYS;


  $user = "User instruction:\n{$instruction}\n\nCurrent files:\n\n{$files_block}\n\nReturn ONLY the JSON object described above.";

  $payload = [
    'model' => 'gpt-4.1-mini',
    'temperature' => 0,
    'messages' => [
      ['role' => 'system', 'content' => $system],
      ['role' => 'user', 'content' => $user],
    ],
  ];

  $res = wp_remote_post('https://api.openai.com/v1/chat/completions', [
    'timeout' => 60,
    'redirection' => 3,
    'httpversion' => '1.1',
    'headers' => [
      'Authorization' => "Bearer {$api_key}",
      'Content-Type'  => 'application/json',
    ],
    'body' => wp_json_encode($payload),
  ]);

  if (is_wp_error($res)) {
  $inner = osrs_agent_format_wp_error($res);
  $inner_msg = is_array($inner) && !empty($inner['message']) ? $inner['message'] : $res->get_error_message();

  return new WP_Error(
    'osrs_openai_http',
    'OpenAI plan request failed: ' . $inner_msg,
    $inner
  );
}


  $code = wp_remote_retrieve_response_code($res);
  $raw  = wp_remote_retrieve_body($res);
  $json = json_decode($raw, true);

  if ($code < 200 || $code >= 300) {
    return new WP_Error('osrs_openai_http', "OpenAI HTTP {$code}", ['body' => $json ?: $raw]);
  }

  $content = $json['choices'][0]['message']['content'] ?? '';
  $parsed  = json_decode(trim($content), true);

  if (!$parsed) {
    return new WP_Error('osrs_openai_parse', 'Failed to parse OpenAI plan JSON', ['raw' => $content]);
  }

  return $parsed;
}

function osrs_openai_generate_ops($instruction, $files_map) {
  $api_key = osrs_agent_cfg('OSRS_OPENAI_API_KEY');
  if (!$api_key) return new WP_Error('osrs_agent_cfg', 'Missing OpenAI key in wp-config.php');

  // Keep edits minimal + avoid backend unless explicitly required
  $instruction =
    "Keep changes minimal and focused. Do not add new files. Only modify index.html, style.css, script.js if required.\n" .
    "Prefer client-side filtering over server/AJAX unless the user explicitly requires a backend endpoint.\n\n" .
    $instruction;

  // We DO NOT need to send entire files. Send enough context for anchors.
  // But simplest first step: send full current contents of only the files we plan to modify.
  $parts = [];
  foreach ($files_map as $path => $info) {
    $parts[] = "FILE: {$path}\n<<<\n{$info['content']}\n>>>";
  }
  $files_block = implode("\n\n", $parts);

  $system = <<<SYS
You are a code editor.

Return ONLY a JSON object describing deterministic edit operations to apply to the given files.
Do NOT include markdown fences. Return a single JSON object only.

Rules:
- Use ONLY these operation types:
  - replace_once: replace a unique exact string
  - insert_after_once: insert text immediately after a unique exact anchor string
  - insert_before_once: insert text immediately before a unique exact anchor string
- The "find" anchor MUST appear exactly once in the target file.
- Prefer anchors that include a unique ID attribute (e.g. id="cash", id="itemsCap", id="sortSel", etc.) or the unique controls comment.
- DO NOT use generic anchors like:
  "<div class=\\"row\\"" , "class=\\"row\\"" , "</div>" , "<label" , "<th" or other repeated tags.
- If you cannot find a unique anchor, set modified:false for that file.

Return JSON format:

{
  "changes": {
    "index.html": { "modified": true/false, "summary": "...", "snippet": "...", "ops": [ ... ] },
    "style.css":  { "modified": true/false, "summary": "...", "snippet": "...", "ops": [ ... ] },
    "script.js":  { "modified": true/false, "summary": "...", "snippet": "...", "ops": [ ... ] }
  }
}

Each op looks like:
{ "type": "insert_after_once", "find": "ANCHOR", "insert": "TEXT_TO_INSERT", "note": "why" }
or
{ "type": "replace_once", "find": "EXACT_OLD", "replace": "EXACT_NEW", "note": "why" }
SYS;



  $user = "User instruction:\n{$instruction}\n\nCurrent files:\n\n{$files_block}\n\nReturn ONLY the JSON ops object described above.";

  $payload = [
    'model' => 'gpt-4.1-mini',
    'temperature' => 0,
    'messages' => [
      ['role' => 'system', 'content' => $system],
      ['role' => 'user', 'content' => $user],
    ],
  ];

  $res = wp_remote_post('https://api.openai.com/v1/chat/completions', [
    'timeout' => 60, // ✅ keep short; ops responses should be fast
    'redirection' => 3,
    'httpversion' => '1.1',
    'headers' => [
      'Authorization' => "Bearer {$api_key}",
      'Content-Type'  => 'application/json',
    ],
    'body' => wp_json_encode($payload),
  ]);

  if (is_wp_error($res)) {
    $inner = osrs_agent_format_wp_error($res);
    $inner_msg = is_array($inner) && !empty($inner['message']) ? $inner['message'] : $res->get_error_message();
    return new WP_Error('osrs_openai_http', 'OpenAI ops generate request failed: ' . $inner_msg, $inner);
  }

  $code = wp_remote_retrieve_response_code($res);
  $raw  = wp_remote_retrieve_body($res);
  $json = json_decode($raw, true);

  if ($code < 200 || $code >= 300) {
    return new WP_Error('osrs_openai_http', "OpenAI HTTP {$code}", ['body' => $json ?: $raw]);
  }

  $content = $json['choices'][0]['message']['content'] ?? '';
  $parsed  = json_decode(trim($content), true);

  if (!$parsed) {
    return new WP_Error('osrs_openai_parse', 'Failed to parse OpenAI ops JSON', ['raw' => $content]);
  }

  return $parsed;
}


/**
 * VALIDATION
 */
function osrs_agent_validate_proposal($proposal) {
  $allowed = osrs_agent_allowed_files();

  if (!isset($proposal['changes']) || !is_array($proposal['changes'])) {
    return new WP_Error('osrs_agent_invalid', 'Proposal missing changes object');
  }

  foreach ($proposal['changes'] as $path => $change) {
    if (!in_array($path, $allowed, true)) {
      return new WP_Error('osrs_agent_invalid', "Proposal attempted to edit disallowed file: {$path}");
    }

    $modified = !empty($change['modified']);
    if ($modified) {
      $new = $change['new_content'] ?? '';
      if (!is_string($new) || trim($new) === '') {
        return new WP_Error('osrs_agent_invalid', "Modified file {$path} missing full new_content");
      }
      // Block placeholder ellipsis lines (but allow legitimate "Loading..." etc.)
if (preg_match('/^\s*\.{3}\s*$/m', $new)) {
  return new WP_Error('osrs_agent_invalid', "Modified file {$path} contains a standalone '...' placeholder line");
}

      if (strpos($new, '```') !== false) {
        return new WP_Error('osrs_agent_invalid', "Modified file {$path} contains markdown code fences");
      }
    }
  }

  return true;
}

/**
 * REST: /propose  (plan only)
 */
function osrs_agent_propose(\WP_REST_Request $req) {
  $instruction = trim((string) $req->get_param('instruction'));
  if ($instruction === '') return new WP_Error('osrs_agent_input', 'Instruction is required');

  // Fetch current files from GitHub
  $files = [];
  foreach (osrs_agent_allowed_files() as $path) {
    $info = osrs_github_get_file($path);
    if (is_wp_error($info)) return $info;

    $content_b64 = $info['content'] ?? '';
    $sha         = $info['sha'] ?? '';
    $decoded     = base64_decode($content_b64);

    if ($decoded === false) {
      return new WP_Error('osrs_agent_decode', "Failed to decode {$path} from GitHub");
    }

    $files[$path] = [
      'sha'     => $sha,
      'content' => $decoded,
    ];
  }

  // ✅ Plan-only (fast)
  $plan = osrs_openai_plan_only($instruction, $files);
  if (is_wp_error($plan)) return $plan;

  $proposal_id = 'osrs_' . wp_generate_uuid4();
  $store = [
    'created_at'  => time(),
    'instruction' => $instruction,
    'files'       => $files,   // sha + original contents
    'plan'        => $plan,
    'generated'   => null,     // set by /generate
  ];
  set_transient($proposal_id, $store, 30 * MINUTE_IN_SECONDS);

  return [
    'proposal_id' => $proposal_id,
    'requirements_heard' => $plan['requirements_heard'] ?? '',
    'plan' => $plan['plan'] ?? '',
    'will_modify' => $plan['will_modify'] ?? [],
  ];
}

function osrs_agent_apply_ops($original, array $ops, $path) {
  $content = $original;

  foreach ($ops as $i => $op) {
    $type    = $op['type'] ?? '';
    $note    = $op['note'] ?? '';
    $find    = $op['find'] ?? '';
    $replace = $op['replace'] ?? '';
    $insert  = $op['insert'] ?? '';

    if ($type === 'replace_once') {
      if (!is_string($find) || $find === '') {
        return new WP_Error('osrs_agent_ops', "Op #{$i} replace_once missing find for {$path}");
      }
      $count = 0;
      $content = str_replace($find, $replace, $content, $count);
      if ($count !== 1) {
        return new WP_Error('osrs_agent_ops', "Op #{$i} replace_once expected 1 match, got {$count} in {$path}. Note: {$note}");
      }
      continue;
    }

    if ($type === 'insert_after_once') {
      if (!is_string($find) || $find === '') {
        return new WP_Error('osrs_agent_ops', "Op #{$i} insert_after_once missing find for {$path}");
      }
      if (substr_count($content, $find) !== 1) {
        return new WP_Error('osrs_agent_ops', "Op #{$i} insert_after_once anchor not unique in {$path}. Note: {$note}");
      }
      $pos = strpos($content, $find);
      if ($pos === false) {
        return new WP_Error('osrs_agent_ops', "Op #{$i} insert_after_once could not find anchor in {$path}. Note: {$note}");
      }
      $insertPos = $pos + strlen($find);
      $content = substr($content, 0, $insertPos) . $insert . substr($content, $insertPos);
      continue;
    }

    if ($type === 'insert_before_once') {
      if (!is_string($find) || $find === '') {
        return new WP_Error('osrs_agent_ops', "Op #{$i} insert_before_once missing find for {$path}");
      }
      if (substr_count($content, $find) !== 1) {
        return new WP_Error('osrs_agent_ops', "Op #{$i} insert_before_once anchor not unique in {$path}. Note: {$note}");
      }
      $pos = strpos($content, $find);
      if ($pos === false) {
        return new WP_Error('osrs_agent_ops', "Op #{$i} insert_before_once could not find anchor in {$path}. Note: {$note}");
      }
      $content = substr($content, 0, $pos) . $insert . substr($content, $pos);
      continue;
    }

    return new WP_Error('osrs_agent_ops', "Unknown op type '{$type}' for {$path}. Note: {$note}");
  }

  return $content;
}


/**
 * REST: /generate  (full file contents, still pre-commit)
 */
function osrs_agent_generate(\WP_REST_Request $req) {
  $proposal_id = (string) $req->get_param('proposal_id');
  if (!$proposal_id) return new WP_Error('osrs_agent_input', 'proposal_id is required');

  $store = get_transient($proposal_id);
  if (!$store) return new WP_Error('osrs_agent_missing', 'Proposal not found or expired');

  // If already generated, return cached
  if (!empty($store['generated']) && is_array($store['generated'])) {
    return [
      'proposal_id' => $proposal_id,
      'changes' => $store['generated']['changes'] ?? [],
    ];
  }

  $instruction = $store['instruction'];
  $files_all   = $store['files'];
  $will_modify = $store['plan']['will_modify'] ?? [];

  // Only include files the plan says will change (keeps request small/fast)
  $files_for_ai = [];
  foreach (osrs_agent_allowed_files() as $path) {
    if (!empty($will_modify[$path])) {
      $files_for_ai[$path] = $files_all[$path];
    }
  }

  if (empty($files_for_ai)) {
    return new WP_Error('osrs_agent_invalid', 'Plan indicates no files need changes, so nothing to generate.');
  }

  // Ask OpenAI for deterministic ops (fast)
$anchor_hints =
  "\n\nANCHOR HINTS (must use unique anchors that appear exactly once):\n" .
  "- For index.html inserts near the controls, prefer this unique comment anchor:\n" .
  "  <!-- Controls: grouped into 3 tidy rows; IDs unchanged -->\n" .
  "- Otherwise use anchors containing unique IDs such as id=\"cash\", id=\"itemsCap\", id=\"sortSel\".\n" .
  "- Never anchor on class=\"row\" or other repeated tags.\n";

$ops_result = osrs_openai_generate_ops($instruction . $anchor_hints, $files_for_ai);
  if (is_wp_error($ops_result)) return $ops_result;

  $changes = $ops_result['changes'] ?? null;
  if (!is_array($changes)) {
    return new WP_Error('osrs_agent_invalid', 'Ops response missing changes object');
  }

  // Build full new_content locally by applying ops
  $final_changes = [];
  foreach (osrs_agent_allowed_files() as $path) {
    $c = $changes[$path] ?? ['modified' => false];
    $modified = !empty($c['modified']);

    if (!$modified) {
      $final_changes[$path] = [
        'modified' => false,
        'summary' => $c['summary'] ?? '',
        'snippet' => $c['snippet'] ?? '',
      ];
      continue;
    }

    $ops = $c['ops'] ?? [];
    if (!is_array($ops) || empty($ops)) {
      return new WP_Error('osrs_agent_invalid', "File {$path} marked modified but ops were missing/empty");
    }

    $original = $files_all[$path]['content'];
    $applied = osrs_agent_apply_ops($original, $ops, $path);
    if (is_wp_error($applied)) return $applied;

    $final_changes[$path] = [
      'modified' => true,
      'summary' => $c['summary'] ?? '',
      'snippet' => $c['snippet'] ?? '',
      'new_content' => $applied,
    ];
  }

  // Validate final result with your existing validator (now it *will* have new_content)
  $valid = osrs_agent_validate_proposal(['changes' => $final_changes]);
  if (is_wp_error($valid)) return $valid;

  $store['generated'] = ['changes' => $final_changes];
  set_transient($proposal_id, $store, 30 * MINUTE_IN_SECONDS);

  return [
    'proposal_id' => $proposal_id,
    'changes' => $final_changes,
  ];
}

function osrs_agent_generate_manual(\WP_REST_Request $req) {
  $proposal_id = (string) $req->get_param('proposal_id');
  if (!$proposal_id) return new WP_Error('osrs_agent_input', 'proposal_id is required');

  $manual = $req->get_param('manual');
  if (!$manual) return new WP_Error('osrs_agent_input', 'manual JSON is required');

  // manual may arrive as string or decoded object depending on caller
  if (is_string($manual)) {
    $decoded = json_decode($manual, true);
    if (!$decoded) return new WP_Error('osrs_agent_input', 'manual must be valid JSON');
    $manual = $decoded;
  }

  if (!is_array($manual) || !isset($manual['changes']) || !is_array($manual['changes'])) {
    return new WP_Error('osrs_agent_input', 'manual JSON must be { "changes": { ... } }');
  }

  $store = get_transient($proposal_id);
  if (!$store) return new WP_Error('osrs_agent_missing', 'Proposal not found or expired');

  $files_all = $store['files']; // sha + original content
  $changes_in = $manual['changes'];

  // Build full new_content locally by applying ops
  $final_changes = [];

  foreach (osrs_agent_allowed_files() as $path) {
    $c = $changes_in[$path] ?? ['modified' => false];
    $modified = !empty($c['modified']);

    if (!$modified) {
      $final_changes[$path] = [
        'modified' => false,
        'summary' => (string)($c['summary'] ?? ''),
        'snippet' => (string)($c['snippet'] ?? ''),
      ];
      continue;
    }

    $ops = $c['ops'] ?? null;
    if (!is_array($ops) || empty($ops)) {
      return new WP_Error('osrs_agent_invalid', "Manual changes: {$path} modified:true but ops missing/empty");
    }

    $original = $files_all[$path]['content'];

    if (!function_exists('osrs_agent_apply_ops')) {
      return new WP_Error('osrs_agent_missing', 'osrs_agent_apply_ops() not found. Ensure ops applier helper is defined.');
    }

    $applied = osrs_agent_apply_ops($original, $ops, $path);
    if (is_wp_error($applied)) return $applied;

    $final_changes[$path] = [
      'modified' => true,
      'summary' => (string)($c['summary'] ?? ''),
      'snippet' => (string)($c['snippet'] ?? ''),
      'new_content' => $applied,
    ];
  }

  // Validate final result with your existing validator
  $valid = osrs_agent_validate_proposal(['changes' => $final_changes]);
  if (is_wp_error($valid)) return $valid;

  $store['generated'] = ['changes' => $final_changes];
  set_transient($proposal_id, $store, 30 * MINUTE_IN_SECONDS);

  return [
    'proposal_id' => $proposal_id,
    'changes' => $final_changes,
  ];
}


/**
 * REST: /commit  (push to GitHub using generated changes)
 */
function osrs_agent_commit(\WP_REST_Request $req) {
  $proposal_id = (string) $req->get_param('proposal_id');
  if (!$proposal_id) return new WP_Error('osrs_agent_input', 'proposal_id is required');

  $store = get_transient($proposal_id);
  if (!$store) return new WP_Error('osrs_agent_missing', 'Proposal not found or expired');

$generated = $store['generated']['changes'] ?? null;
if (!$generated || !is_array($generated)) {
  return new WP_Error('osrs_agent_missing', 'No generated changes found. Click Generate before committing.');
}

$changes = $generated;
$files_all = $store['files'];
$instruction = $store['instruction'];


  if (empty($changes)) {
    return new WP_Error('osrs_agent_missing', 'No generated changes found. Click Generate before committing.');
  }

  $results = [];

  foreach (osrs_agent_allowed_files() as $path) {
    $change = $changes[$path] ?? null;
    if (!$change || empty($change['modified'])) continue;

    $new_content = $change['new_content'];
$sha         = $files_all[$path]['sha'];

    $msg = substr(preg_replace('/\s+/', ' ', $instruction), 0, 60) . " ({$path})";

    $res = osrs_github_update_file($path, $new_content, $sha, $msg);
    if (is_wp_error($res)) return $res;

    $results[] = [
      'file' => $path,
      'commit_sha' => $res['commit']['sha'] ?? null,
    ];
  }

  delete_transient($proposal_id);

  return [
    'ok' => true,
    'commits' => $results,
  ];
}

/**
 * REST: /diagnostics  (call from UI)
 */
function osrs_agent_diagnostics() {
  $checks = [];

  $targets = [
    'openai_models' => [
      'url' => 'https://api.openai.com/v1/models',
      'headers' => [
        'Authorization' => 'Bearer ' . osrs_agent_cfg('OSRS_OPENAI_API_KEY', ''),
        'Content-Type'  => 'application/json',
      ],
    ],
    'github_root' => [
      'url' => 'https://api.github.com',
      'headers' => [
        'User-Agent' => 'OSRS-WP-Agent',
      ],
    ],
  ];

  foreach ($targets as $name => $t) {
    $res = wp_remote_get($t['url'], [
      'timeout' => 20,
      'redirection' => 2,
      'httpversion' => '1.1',
      'headers' => $t['headers'],
    ]);

    if (is_wp_error($res)) {
      $checks[$name] = [
        'ok' => false,
        'error' => osrs_agent_format_wp_error($res),
      ];
      continue;
    }

    $status = wp_remote_retrieve_response_code($res);
    $checks[$name] = [
      'ok' => ($status >= 200 && $status < 400),
      'status' => $status,
    ];
  }

  return ['checks' => $checks];
}
