"""Builds load/load_to_supabase.ipynb from the migration and loader SQL so they never drift apart.
Run: python3 supabase/build_notebook.py"""
import json, pathlib
here = pathlib.Path(__file__).parent
mig = sorted((here / 'migrations').glob('*.sql'))
loader = (here / 'load' / 'load_csv.sql').read_text()

def md(s): return {'cell_type': 'markdown', 'metadata': {}, 'source': s.strip('\n').splitlines(True)}
def code(s): return {'cell_type': 'code', 'metadata': {}, 'execution_count': None, 'outputs': [], 'source': s.strip('\n').splitlines(True)}

cells = [
 md("""# Load BTC data into Supabase
Run the cells **top to bottom** (Runtime → Run all works too). It makes the tables, then loads your Colab download.
Safe to run again: existing rows are skipped, only new rows are added."""),
 md("## 1. Install the database tool"),
 code("!apt-get -qq update > /dev/null && apt-get -qq install -y postgresql-client > /dev/null && psql --version"),
 md("## 2. Upload `delta_btc_data.zip`\nClick **Choose files** and pick the zip you downloaded earlier."),
 code("""import os, zipfile
from google.colab import files
os.makedirs('/content/data', exist_ok=True)
up = files.upload()
for name in up:
    if name.endswith('.zip'):
        zipfile.ZipFile(name).extractall('/content/data')
    else:
        os.replace(name, '/content/data/' + name)
need = ['btc_spot_1h.csv', 'btc_options_products.csv', 'btc_options_1h.csv']
missing = [f for f in need if not os.path.exists('/content/data/' + f)]
print('Missing files:', missing) if missing else print('All 3 files found:', need)"""),
 md("""## 3. Connection details
In Supabase: open your project → **Connect** (top bar) → **Session pooler**. Copy the **Host** and **User** (looks like `postgres.abcdefgh`). 
The password is the database password you set when you created the project. It is typed into a hidden box and is not saved in this notebook."""),
 code("""import getpass, os
os.environ['PGHOST'] = input('Host (aws-0-...pooler.supabase.com): ').strip()
os.environ['PGUSER'] = input('User (postgres.xxxxxxxx): ').strip()
os.environ['PGPASSWORD'] = getpass.getpass('Database password: ')
os.environ['PGPORT'] = '5432'
os.environ['PGDATABASE'] = 'postgres'
os.environ['PGSSLMODE'] = 'require'
!psql -c "select 'connected' as status"
"""),
 md("## 4. Create the tables and views"),
]
for f in mig:
    name = f.name
    cells.append(code(f"%%writefile /content/{name}\n" + f.read_text()))
cells.append(code("!for f in /content/2*.sql; do echo \"== $f\"; psql -v ON_ERROR_STOP=1 -q -f $f || exit 1; done; echo done"))
cells += [
 md("## 5. Load the data (takes about 1 to 3 minutes)"),
 code("%%writefile /content/data/load_csv.sql\n" + loader),
 code("!cd /content/data && psql -v ON_ERROR_STOP=1 -q -f load_csv.sql"),
 md("""## 6. Check
The last table should show about **8,800 spot rows, 20,440 contracts and 520,441 option candles**."""),
 code("!psql -c \"select * from public.v_data_coverage\""),
]
nb = {'cells': cells, 'metadata': {'colab': {'provenance': []}, 'kernelspec': {'name': 'python3', 'display_name': 'Python 3'}, 'language_info': {'name': 'python'}}, 'nbformat': 4, 'nbformat_minor': 5}
out = here / 'load' / 'load_to_supabase.ipynb'
out.write_text(json.dumps(nb, indent=1))
print('wrote', out)
