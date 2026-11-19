# Template escaping rules for Ansible/Jinja2

## Rule

Every `{{ }}` interpolation in a Jinja2 template must be evaluated against
its *consumption context* and escaped accordingly:

1. **Should this be escaped?** — Yes, whenever the substituted value can
   contain characters that are special in the target format (quotes,
   backslashes, newlines, control characters, `%`, `&`, `<`, `>`, etc.).
2. **How do I escape it?** — Use the correct filter for the target format.
   If no good answer exists or the answer is nontrivial, report back before
   implementing.

## Contexts in this repo

### systemd EnvironmentFile (`.env`, `/etc/keycloak.env`)

**Files:** `roles/node_express_app/templates/app.env.j2`,
`roles/keycloak/templates/keycloak.env.j2`

systemd `EnvironmentFile` parsing (see `systemd.exec(5)`):
- Values may be unquoted, single-quoted, or double-quoted.
- In unquoted values, `"`, `` ` ``, `$`, and `\` must be backslash-escaped.
- Newlines are not allowed (values are single-line).
- If we write `KEY={{ value }}` without quoting, the raw value is inserted
  verbatim — a password containing `$` or `` ` `` would break parsing or be
  misinterpreted by the shell-like evaluator.

**Fix:** Add a `systemd_env_escape` Jinja2 filter (Python, in a
`filter_plugins/` module) that backslash-escapes `"` `` ` `` `$` `\`, and
always quote the value in the template:

```jinja2
KC_DB_PASSWORD="{{ keycloak_db_password | systemd_env_escape }}"
```

The filter does not add surrounding quotes — the template caller must.

### systemd unit files (`ExecStart`, `Description`, `User`, `Group`, `After`, ...)

**Files:** `roles/node_express_app/templates/node-express.service.j2`,
`roles/keycloak/templates/keycloak.service.j2`

systemd unit escaping (see `systemd.exec(5)`, "Command Lines"):
- `%` must be doubled (`%%`) because `%` is a specifier.
- `\` must be `\\`.
- `"` must be `\"`.
- Control characters (< 0x20 or 0x7F) must be `\xHH`.
- Arguments must be individually quoted and separated by spaces; the whole
  value is prefixed with `:`.

**Fix:** Add a `systemd_exec_escape` Jinja2 filter that takes a list of
strings and returns `: "arg1" "arg2" ...`:

```jinja2
ExecStart={{ [node_bin, app_root ~ "/server.js"] | systemd_exec_escape }}
```

For simple scalar values like `User={{ app_user }}`, apply
`systemd_env_escape` and quote:

```jinja2
User="{{ app_user | systemd_env_escape }}"
```

### JSON (realm import)

**File:** `roles/keycloak/templates/realm.json.j2`

JSON string escaping: `"`, `\`, and control characters must be escaped.

**Fix:** Use Jinja2's built-in `tojson` filter, which produces a valid
JSON string literal including surrounding quotes:

```jinja2
"realm": {{ keycloak_realm | tojson }}
"sslRequired": {{ keycloak_ssl_required | tojson }}
```

Note: `tojson` includes quotes, so it replaces `"{{ x }}"` with
`{{ x | tojson }}`.

### MySQL option file (`zz-ansible.cnf`)

**File:** `roles/mysql/templates/zz-ansible.cnf.j2`

MySQL option file format (see
https://dev.mysql.com/doc/refman/9.7/en/option-files.html):
- Within `[section]` groups, `KEY = value`.
- Values containing `#`, `;`, `"`, `'`, or whitespace should be quoted.
- Inside double-quoted values, `"` must be `\"` and `\` must be `\\`.
- Inside single-quoted values, `'` must be `''`.
- Unquoted values cannot contain whitespace.

**Fix:** Apply `systemd_env_escape`-style escaping (backslash-escape `"`
`$` `\`) and double-quote:

```jinja2
bind-address = "{{ mysql_bind_address | systemd_env_escape }}"
port = "{{ mysql_port | systemd_env_escape }}"
```

(Or omit quotes when the value is known-safe, e.g. a plain IPv4 or integer
port, but escaping+quoting is always safe.)

## Templates audited

| Template | Context | Escaping needed |
|---|---|---|
| `app.env.j2` | systemd EnvironmentFile | `systemd_env_escape` + quotes |
| `keycloak.env.j2` | systemd EnvironmentFile | `systemd_env_escape` + quotes |
| `node-express.service.j2` | systemd unit | `systemd_env_escape` for scalars, `systemd_exec_escape` for `ExecStart` list |
| `keycloak.service.j2` | systemd unit | `systemd_env_escape` for scalars, `systemd_exec_escape` for `ExecStart` list |
| `realm.json.j2` | JSON | `tojson` |
| `zz-ansible.cnf.j2` | MySQL option file | `systemd_env_escape` + quotes |

## Implementation plan

1. Create `filter_plugins/systemd.py` with `systemd_env_escape` and
   `systemd_exec_escape` filters.
2. Register the filter plugin directory in `ansible.cfg` (or set
   `ANSIBLE_FILTER_PLUGINS`).
3. Update each template to apply the correct filter and quoting.
4. Verify with `ansible-playbook --syntax-check` and a full inttest run.