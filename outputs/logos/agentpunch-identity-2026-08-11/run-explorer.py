import importlib.util
import sys
from pathlib import Path

script = Path(r"C:\Users\32734\.agents\skills\creative-production-logo-explorer\scripts\create_logo_explorer.py")
spec = importlib.util.spec_from_file_location("logo_creator", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.plugin_version_label = lambda: "creative-production-logo-explorer@local"
sys.argv = [
    str(script),
    "--spec", str(Path(__file__).with_name("logo-spec.source.json")),
    "--output", str(Path(__file__).with_name("explorer")),
    "--force",
]
module.main()
