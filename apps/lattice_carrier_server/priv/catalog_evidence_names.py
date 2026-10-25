"""Read-only, bounded directory enumeration for the operator evidence reader."""
import json
import os
import sys


def main():
    if len(sys.argv) != 2:
        return 1
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        names = []
        with os.scandir(fd) as entries:
            for entry in entries:
                if len(names) == 2048:
                    return 2
                names.append(entry.name)
        print(json.dumps(names, ensure_ascii=True, separators=(",", ":")))
        return 0
    finally:
        os.close(fd)


try:
    sys.exit(main())
except (OSError, ValueError):
    sys.exit(1)
