"""Jinja2 filters for escaping values in systemd unit files and EnvironmentFiles.

See `systemd.exec(5)` for the value formats.
"""


def systemd_env_escape(value: str) -> str:
    """Escape a string for use as a value in a systemd ``EnvironmentFile``.

    See the `systemd.exec(5) manual
    <https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#EnvironmentFile=>`
    for the value format. This function does not quote the value, allowing it
    to be used in interpolated strings. The caller MUST quote the returned
    value themselves, for example::

        GREETING="Hi, I'm {{ name | systemd_env_escape }}!"

    :param value: The string to escape.
    :return: The escaped string, without surrounding quotes.
    """
    if not isinstance(value, str):
        value = str(value)
    NEEDS_ESCAPING = '"`$\\'
    out = []
    for char in value:
        if char in NEEDS_ESCAPING:
            out.append('\\')
        out.append(char)
    return ''.join(out)


def _encode_control(ch: str) -> str:
    return '\\x%02x' % ord(ch)


def _quote_argument(content: str) -> str:
    out = ['"']
    for ch in content:
        o = ord(ch)
        if ch == '\\':
            out.append('\\\\')
        elif ch == '"':
            out.append('\\"')
        elif o < 0x20 or o == 0x7F:
            out.append(_encode_control(ch))
        else:
            out.append(ch)
    out.append('"')
    return ''.join(out)


def systemd_exec_escape(argv) -> str:
    """Escape an argument vector for use as a systemd ``ExecStart=`` value.

    Takes a list of strings and returns a systemd command line string where
    each argument is individually quoted: ``/usr/bin/node "--foo" "bar"``.
    Backslashes and double quotes are escaped, control characters are encoded
    as ``\\xHH``, and bare ``%`` characters are doubled (``%%``) because
    systemd treats ``%`` as a specifier.

    :param argv: A list of argument strings.
    :return: A systemd command line string (no leading ``:``).
    """
    if not argv:
        raise ValueError('argument vector must be non-empty')

    parts = []
    for arg in argv:
        if not isinstance(arg, str):
            arg = str(arg)
        content = arg.replace('%', '%%')
        parts.append(_quote_argument(content))

    return ':' + ' '.join(parts)


class FilterModule:
    """Jinja2 filter module for systemd escaping."""

    def filters(self):
        return {
            'systemd_env_escape': systemd_env_escape,
            'systemd_exec_escape': systemd_exec_escape,
        }


# Allow direct import as well.
__all__ = ['systemd_env_escape', 'systemd_exec_escape', 'FilterModule']
