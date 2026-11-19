"""Jinja2 filters for escaping values in MySQL option files.

See MySQL 8.0 Reference Manual, Section 6.2.2.2 "Using Option Files":
https://dev.mysql.com/doc/refman/8.0/en/option-files.html

Key rules:
- Comment lines start with `` # `` or `` ; ``. A `` # `` comment can start
  in the middle of a line, so `` # `` inside an unquoted value breaks the file.
- Values may be enclosed in single or double quotes; this is required when the
  value contains `` # ``, `` ; ``, `` " ``, `` ' ``, or whitespace.
- Inside double quotes: `` \" `` escapes a double quote, `` \\\\ `` escapes a
  backslash. Escape sequences `` \\b ``, `` \\t ``, `` \\n ``, `` \\r ``,
  `` \\\\ ``, `` \\s `` are recognized. A backslash not followed by a valid
  escape sequence character remains unchanged.
- Leading and trailing spaces are stripped from values.
"""


def mysql_option_escape(value: str) -> str:
    """Escape a string for use as a value in a MySQL option file.

    Returns the value unquoted when it contains no characters that require
    quoting; otherwise returns a double-quoted, escaped string. The caller
    should NOT add additional surrounding quotes.

    :param value: The string to escape.
    :return: The escaped string, optionally double-quoted.
    """
    if not isinstance(value, str):
        value = str(value)

    # Characters that require quoting inside a MySQL option file value.
    # Backslash is significant (escape sequences like \s, \n, \t, \\), so
    # it must be quoted and escaped too.
    NEEDS_QUOTE = set('#;\'" \t\n\r\\')
    if not any(ch in NEEDS_QUOTE for ch in value):
        return value

    out = ['"']
    for ch in value:
        if ch == '\\':
            out.append('\\\\')
        elif ch == '"':
            out.append('\\"')
        elif ch == '\n':
            out.append('\\n')
        elif ch == '\r':
            out.append('\\r')
        elif ch == '\t':
            out.append('\\t')
        elif ch == '\b':
            out.append('\\b')
        else:
            out.append(ch)
    out.append('"')
    return ''.join(out)


class FilterModule:
    """Jinja2 filter module for MySQL option file escaping."""

    def filters(self):
        return {
            'mysql_option_escape': mysql_option_escape,
        }


__all__ = ['mysql_option_escape', 'FilterModule']
