"""Reconstruct one recorded upstream source candidate and verify every changed input."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reconstruct(name, archive_path, destination):
    owner = Path(__file__).resolve().parent
    manifest = json.loads((owner / 'manifest.json').read_text())
    source = next(row for row in manifest['sources'] if row['name'] == name)
    assert not destination.exists(), f'Destination exists: {destination}'
    assert sha256(archive_path) == source['archive']['sha256'], 'Archive digest differs'
    patch = owner / source['patch']
    assert sha256(patch) == source['patchSha256'], 'Patch digest differs'
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='coverage-source-') as temporary:
        with tarfile.open(archive_path) as archive:
            archive.extractall(temporary, filter='data')
        roots = list(Path(temporary).iterdir())
        assert len(roots) == 1 and roots[0].is_dir(), 'Expected one archive root'
        shutil.move(str(roots[0]), destination)
    subprocess.run(['git', 'apply', '--unidiff-zero', str(patch)],
                   cwd=destination, check=True)
    for item in source['inputs']:
        target = destination / item['path']
        if 'asset' in item:
            asset = owner / item['asset']
            assert sha256(asset) == item['sha256'], item['asset']
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(asset, target)
        if item['sha256'] is None:
            assert not target.exists(), item['path']
        else:
            assert sha256(target) == item['sha256'], item['path']
    print(json.dumps({'source': name, 'destination': str(destination),
                      'verifiedInputs': len(source['inputs'])}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('archive', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    reconstruct(args.source, args.archive.resolve(), args.destination.resolve())


if __name__ == '__main__':
    main()
