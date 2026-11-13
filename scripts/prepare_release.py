"""Stage the public IconMaker assets for a Cloudflare Pages direct upload."""
from pathlib import Path
import shutil
import tempfile

root = Path(__file__).resolve().parent.parent
output = Path(tempfile.mkdtemp(prefix="iconmaker-release-"))
assets = [root / "index.html", root / "VERSION", root / "CHANGELOG.md", root / ".nojekyll"]
for pattern in ("*.js", "*.css", "*.svg"):
    assets.extend(sorted(root.glob(pattern)))
for source in assets:
    shutil.copyfile(source, output / source.name)
shutil.copytree(root / "vendor", output / "vendor")
print(output)
