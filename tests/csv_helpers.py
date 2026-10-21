"""Read the preserved CSV inputs without importing a historical test suite."""
import csv


def rows(file):
    with file.open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))
