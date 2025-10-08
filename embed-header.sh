#!/bin/sh
# Convert qjsx-module-resolution.h into a C string literal for embedding in qjsxc

set -e

INPUT="qjsx-module-resolution.h"
OUTPUT="qjsx-module-resolution-embedded.h"

cat > "$OUTPUT" << 'HEADER_START'
/* Auto-generated from qjsx-module-resolution.h - DO NOT EDIT */
#ifndef QJSX_MODULE_RESOLUTION_EMBEDDED_H
#define QJSX_MODULE_RESOLUTION_EMBEDDED_H

static const char *qjsx_module_resolution_code =
HEADER_START

# Read the input file, skip header guards and includes, convert to string literal
awk '
BEGIN { skip = 1; }
/^#ifndef QJSX_MODULE_RESOLUTION_H/ { next; }
/^#define QJSX_MODULE_RESOLUTION_H/ { next; }
/^#endif.*QJSX_MODULE_RESOLUTION_H/ { next; }
/^#include/ { next; }
/^$/ && skip { next; }
/^\/\*/ {
    if (!skip) {
        # Print comment lines
        gsub(/\\/, "\\\\\\\\");
        gsub(/"/, "\\\"");
        printf("\"%s\\n\"\n", $0);
    }
    next;
}
/\*\/$/ {
    if (!skip) {
        gsub(/\\/, "\\\\\\\\");
        gsub(/"/, "\\\"");
        printf("\"%s\\n\"\n", $0);
    }
    next;
}
/^#/ || /^static / { skip = 0; }
!skip {
    # Escape backslashes and quotes
    gsub(/\\/, "\\\\\\\\");
    gsub(/"/, "\\\"");
    printf("\"%s\\n\"\n", $0);
}
' "$INPUT" >> "$OUTPUT"

cat >> "$OUTPUT" << 'HEADER_END'
;

#endif /* QJSX_MODULE_RESOLUTION_EMBEDDED_H */
HEADER_END

echo "Generated $OUTPUT from $INPUT"
