"""Build a private, non-widening settings snapshot. Never execute imported code."""
import hashlib
import json
import os
from pathlib import Path
import shlex

PREFERENCES = {'theme': str, 'language': str, 'outputStyle': str,
               'spinnerTipsEnabled': bool, 'spinnerVerbs': dict,
               'showTurnDuration': bool, 'terminalProgressBarEnabled': bool}
HUD_HASHES = {
    'index.js': '764925ea6d47cf11b777145945ea9a56dbdec4d66219dbd64e4c602b77bcda07',
    'activity-hook.js': '5980db262ec8b904e50c63a5eb040f1e53d83219e48b24737d03336c6e524d98',
}
HUD_EVENTS = {'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
              'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'}


def problem(scope, key):
    # No values, commands, paths or secrets in errors.
    raise ValueError('Selective settings rejected: ' + scope + ' / ' + key)


def strings(value, scope, key):
    if not isinstance(value, list) or any(not isinstance(x, str) or not x or '\0' in x for x in value):
        problem(scope, key)
    return list(dict.fromkeys(value))


def reviewed_hud(command, filename, home):
    if not isinstance(command, str):
        return False
    script = home / 'Documents/claude-hud/dist' / filename
    try:
        if shlex.split(command) != ['/opt/homebrew/bin/node', str(script)]:
            return False
        return hashlib.sha256(script.read_bytes()).hexdigest() == HUD_HASHES[filename]
    except (OSError, ValueError, TypeError):
        return False


def sources(home, cwd):
    """2.1.236 locations: user, cwd project, cwd local, primary checkout local."""
    result = [('user', home / '.claude/settings.json', home / '.claude'),
              ('project', cwd / '.claude/settings.json', cwd),
              ('local', cwd / '.claude/settings.local.json', cwd)]
    for root in (cwd, *cwd.parents):
        marker = root / '.git'
        if not marker.exists() and not marker.is_symlink():
            continue
        primary = root
        if marker.is_file():
            try:
                value = marker.read_text().strip()
                if not value.startswith('gitdir: '):
                    problem('local', 'gitdir')
                gitdir = (root / value[8:]).resolve()
                common = (gitdir / (gitdir / 'commondir').read_text().strip()).resolve()
                primary = common.parent
            except OSError:
                problem('local', 'gitdir')
        if primary != cwd and primary != home:
            result.append(('root-local', primary / '.claude/settings.local.json', cwd))
        break
    return result


def sandbox_part(value, scope, base, home):
    if not isinstance(value, dict):
        problem(scope, 'sandbox')
    out = {}
    true_keys = {'enabled', 'failIfUnavailable'}
    false_keys = {'autoAllowBashIfSandboxed', 'allowUnsandboxedCommands',
                  'enableWeakerNestedSandbox', 'enableWeakerNetworkIsolation', 'allowAppleEvents'}
    omitted = {'excludedCommands', 'ignoreViolations'}
    for key, item in value.items():
        if key in true_keys | false_keys:
            if type(item) is not bool:
                problem(scope, 'sandbox.' + key)
            if item == (key in true_keys):
                out[key] = item
        elif key in omitted:
            continue  # Exceptions widen access; never import them.
        elif key in {'filesystem', 'network'}:
            if not isinstance(item, dict):
                problem(scope, 'sandbox.' + key)
            target = {}
            for sub, entries in item.items():
                if sub in ({'denyRead', 'denyWrite'} if key == 'filesystem' else {'deniedDomains'}):
                    entries = strings(entries, scope, 'sandbox.' + key + '.' + sub)
                    if key == 'filesystem':
                        entries = [str(home / x[2:]) if x.startswith('~/') else
                                   x if x.startswith('/') else str(base / x) for x in entries]
                    target[sub] = entries
                elif sub in ({'allowRead', 'allowWrite'} if key == 'filesystem' else
                             {'allowedDomains', 'allowUnixSockets', 'allowMachLookup', 'httpProxyPort', 'socksProxyPort'}):
                    continue  # No sandbox access exceptions or alternate proxy imported.
                elif sub in ({'disabled'} if key == 'filesystem' else {'allowAllUnixSockets', 'allowLocalBinding'}):
                    if type(entries) is not bool:
                        problem(scope, 'sandbox.' + key + '.' + sub)
                    if entries is False:
                        target[sub] = False
                else:
                    problem(scope, 'sandbox.' + key + '.unsupported')
            if target:
                out[key] = target
        else:
            # Unknown sandbox settings might be restrictions: never silently lose them.
            problem(scope, 'sandbox.unsupported')
    return out


def merge_restrictions(target, incoming):
    for key, value in incoming.items():
        if isinstance(value, dict):
            merge_restrictions(target.setdefault(key, {}), value)
        elif isinstance(value, list):
            target[key] = list(dict.fromkeys(target.get(key, []) + value))
        else:
            target[key] = value  # Only restrictive Boolean values reach this function.


def build_settings(approval_hooks, home=None, cwd=None):
    home, cwd = Path(home or Path.home()).resolve(), Path(cwd or Path.cwd()).resolve()
    configured_home = os.environ.get('CLAUDE_CONFIG_DIR')
    if configured_home and Path(configured_home).expanduser().resolve() != home / '.claude':
        problem('environment', 'CLAUDE_CONFIG_DIR unsupported')
    out = {'hooks': {}, 'skipDangerousModePermissionPrompt': False}
    provenance = []
    seen_hooks = set()
    for scope, path, base in sources(home, cwd):
        if not path.exists() and not path.is_symlink():
            continue
        try:
            raw = path.read_bytes()
            if len(raw) > 1024 * 1024:
                problem(scope, 'file_too_large')
            data = json.loads(raw)
            if not isinstance(data, dict):
                problem(scope, 'object_required')
        except (OSError, ValueError):
            problem(scope, 'unreadable_or_invalid_json')
        retained = []
        def keep(key):
            if key not in retained:
                retained.append(key)
        for key, typ in PREFERENCES.items():
            if key in data:
                if type(data[key]) is not typ:
                    problem(scope, key)
                # spinnerVerbs is data only, but retain only its documented string list.
                if key == 'spinnerVerbs':
                    v = data[key]
                    if set(v) - {'mode', 'verbs'} or v.get('mode') not in {'append', 'replace'}:
                        problem(scope, key)
                    strings(v.get('verbs'), scope, key)
                out[key] = data[key]
                keep(key)
        for key in ('disableAllHooks', 'allowManagedHooksOnly'):
            if data.get(key):
                problem(scope, key + ' conflicts with remote approval')
        permissions = data.get('permissions', {})
        if not isinstance(permissions, dict):
            problem(scope, 'permissions')
        known_permissions = {'deny', 'ask', 'allow', 'defaultMode', 'additionalDirectories', 'disableBypassPermissionsMode', 'disableAutoMode', 'blockReadsOutsideWorkingDirectories'}
        if set(permissions) - known_permissions:
            problem(scope, 'permissions.unsupported')
        for key in ('disableAutoMode',):
            if key in permissions:
                if permissions[key] not in ('enable', 'disable'):
                    problem(scope, 'permissions.' + key)
                if permissions[key] == 'disable':
                    out.setdefault('permissions', {})[key] = 'disable'
                    keep('permissions.' + key)
        if 'blockReadsOutsideWorkingDirectories' in permissions:
            if type(permissions['blockReadsOutsideWorkingDirectories']) is not bool:
                problem(scope, 'permissions.blockReadsOutsideWorkingDirectories')
            if permissions['blockReadsOutsideWorkingDirectories']:
                out.setdefault('permissions', {})['blockReadsOutsideWorkingDirectories'] = True
                keep('permissions.blockReadsOutsideWorkingDirectories')
        for key in ('deny', 'ask'):
            if key in permissions:
                rules = strings(permissions[key], scope, 'permissions.' + key)
                # CLI keeps cwd unchanged: permission patterns keep their native cwd meaning.
                merge_restrictions(out.setdefault('permissions', {}), {key: rules})
                keep('permissions.' + key)
        if permissions.get('disableBypassPermissionsMode') == 'disable':
            out.setdefault('permissions', {})['disableBypassPermissionsMode'] = 'disable'
            keep('permissions.disableBypassPermissionsMode')
        elif 'disableBypassPermissionsMode' in permissions and permissions['disableBypassPermissionsMode'] not in ('enable',):
            problem(scope, 'permissions.disableBypassPermissionsMode')
        if 'sandbox' in data:
            restricted = sandbox_part(data['sandbox'], scope, base, home)
            if restricted:
                merge_restrictions(out.setdefault('sandbox', {}), restricted)
                keep('sandbox.restrictions')
        # Executable configuration is accepted ONLY from the user's reviewed HUD setup.
        status = data.get('statusLine')
        if scope == 'user' and isinstance(status, dict) and status.get('type') == 'command':
            if not reviewed_hud(status.get('command'), 'index.js', home):
                problem(scope, 'statusLine unreviewed or changed')
            if set(status) - {'type', 'command', 'padding'}:
                problem(scope, 'statusLine unsupported fields')
            if 'padding' in status and (type(status['padding']) is not int or status['padding'] < 0):
                problem(scope, 'statusLine.padding')
            out['statusLine'] = status
            keep('statusLine')
        hooks = data.get('hooks', {})
        if scope == 'user' and isinstance(hooks, dict):
            for event in HUD_EVENTS:
                groups = hooks.get(event, [])
                if not isinstance(groups, list):
                    problem(scope, 'hooks.' + event)
                for group in groups:
                    if not isinstance(group, dict) or not isinstance(group.get('hooks'), list):
                        problem(scope, 'hooks.' + event)
                    for h in group['hooks']:
                        if not isinstance(h, dict) or h.get('type') != 'command':
                            continue
                        command = h.get('command')
                        if not reviewed_hud(command, 'activity-hook.js', home):
                            if isinstance(command, str) and 'claude-hud/dist/activity-hook.js' in command:
                                problem(scope, 'hooks.reviewed_hud changed or unsupported')
                            continue
                        matcher = group.get('matcher') or '*'
                        if not isinstance(matcher, str):
                            problem(scope, 'hooks.matcher')
                        signature = (event, matcher, tuple(shlex.split(command)))
                        if signature in seen_hooks:
                            continue
                        seen_hooks.add(signature)
                        out['hooks'].setdefault(event, []).append({'matcher': matcher, 'hooks': [
                            {'type': 'command', 'command': command, 'timeout': 2}]})
                        keep('hooks.' + event + '.reviewed_hud')
        provenance.append({'scope': scope, 'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
                           'retained': retained})
    if 'sandbox' in out:
        # Even a restricted sandbox must not turn successful sandboxing into auto-approval.
        out['sandbox']['autoAllowBashIfSandboxed'] = False
    for event, groups in approval_hooks.items():
        out['hooks'].setdefault(event, []).extend(groups)
    return out, {'sources': provenance, 'policy': 'selective-v1',
                 'precedence': 'user < project < local < root-local; restrictions accumulate; launcher owns approval hooks'}
