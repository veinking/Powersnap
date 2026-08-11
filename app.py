from __future__ import annotations

import hashlib, hmac, json, os, re, secrets, shutil, tempfile, time
from pathlib import Path
from urllib.parse import quote

import pandas as pd
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse

try:
    from openai import OpenAI
except Exception:
    OpenAI = None
try:
    import stripe
except Exception:
    stripe = None

MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
MAX_MB = int(os.getenv("MAX_UPLOAD_MB", "20"))
TTL = int(os.getenv("SESSION_TTL_SECONDS", "3600"))
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:8000").rstrip("/")
ROOT = Path(os.getenv("POWERSNAP_TMP_DIR", Path(tempfile.gettempdir()) / "powersnap"))
ROOT.mkdir(parents=True, exist_ok=True)
ACTIONS = {"trim_whitespace", "remove_duplicates", "parse_dates", "standard_phone", "normalize_email", "remove_empty_rows"}

PROMPT = """You are a Senior Data Quality Engineer. Turn measured CSV data-quality findings into a concise business audit.
Rules: prioritize 3-5 supplied candidate issues; never invent money, percentages, counts, or losses; use only supplied issue IDs/actions/target columns; explain risks in manager-friendly language; if industry is unclear use 'General Business Data'."""
SCHEMA = {"name":"powersnap_audit","strict":True,"schema":{"type":"object","properties":{"industry_detected":{"type":"string"},"business_impact_summary":{"type":"string"},"issues":{"type":"array","minItems":1,"maxItems":5,"items":{"type":"object","properties":{"id":{"type":"string"},"issue_title":{"type":"string"},"business_risk":{"type":"string"},"python_fix_type":{"type":"string","enum":sorted(ACTIONS)},"target_column":{"type":"string"}},"required":["id","issue_title","business_risk","python_fix_type","target_column"],"additionalProperties":False}}},"required":["industry_detected","business_impact_summary","issues"],"additionalProperties":False}}

app = FastAPI(title="PowerSnap API")
app.add_middleware(CORSMiddleware, allow_origins=[x.strip() for x in os.getenv("CORS_ORIGINS", FRONTEND_URL).split(",")], allow_methods=["GET","POST"], allow_headers=["*"])


def sdir(fid: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{32}", fid): raise HTTPException(400, "Invalid file ID")
    return ROOT / fid


def cleanup():
    cutoff = time.time() - TTL
    for p in ROOT.iterdir():
        try:
            if p.is_dir() and p.stat().st_mtime < cutoff: shutil.rmtree(p, ignore_errors=True)
        except FileNotFoundError: pass


def read_csv(path: Path) -> pd.DataFrame:
    try: return pd.read_csv(path)
    except UnicodeDecodeError:
        try: return pd.read_csv(path, encoding="latin-1")
        except Exception as e: raise HTTPException(400, f"Could not read CSV: {e}")
    except Exception as e: raise HTTPException(400, f"Could not read CSV: {e}")


def sig(v) -> str:
    if pd.isna(v): return "<null>"
    out = "".join("#" if c.isdigit() else "A" if c.isalpha() else "_" if c.isspace() else c for c in str(v).strip()[:80])
    return re.sub(r"#{4,}", "####", re.sub(r"A{4,}", "AAAA", out)) or "<blank>"


def iid(action: str, col: str) -> str:
    return f"{action[:12]}_{hashlib.sha1(f'{action}:{col}'.encode()).hexdigest()[:8]}"


def candidates(df: pd.DataFrame) -> list[dict]:
    out = []
    empty = int(df.isna().all(axis=1).sum())
    if empty: out.append({"id":iid("remove_empty_rows","__rows__"),"action_type":"remove_empty_rows","target_column":"__rows__","evidence":f"{empty} completely empty rows detected"})
    for col in df.columns:
        name, low, series = str(col), str(col).lower(), df[col]
        raw = series.dropna().astype(str)
        if len(raw):
            n = int((raw != raw.str.strip()).sum())
            if n: out.append({"id":iid("trim_whitespace",name),"action_type":"trim_whitespace","target_column":name,"evidence":f"{n} values contain leading or trailing whitespace"})
        if "email" in low and len(raw):
            n = int((raw != raw.str.strip().str.lower()).sum())
            if n: out.append({"id":iid("normalize_email",name),"action_type":"normalize_email","target_column":name,"evidence":f"{n} email values differ by casing or whitespace"})
        if any(x in low for x in ("phone","mobile","telephone","tel")) and len(raw):
            digits = raw.str.replace(r"\D", "", regex=True); n = int((raw.str.strip()!=digits).sum())
            if n and int(digits.str.len().between(7,15).sum()): out.append({"id":iid("standard_phone",name),"action_type":"standard_phone","target_column":name,"evidence":f"{n} phone values use inconsistent formatting"})
        if any(x in low for x in ("date","created","updated","closed","opened","dob")) and len(raw)>=2:
            parsed = pd.to_datetime(raw.str.strip(), errors="coerce", format="mixed"); n=int(parsed.notna().sum())
            if n >= max(2,int(len(raw)*.6)) and (n != len(raw) or len({sig(v) for v in raw.head(50)})>1): out.append({"id":iid("parse_dates",name),"action_type":"parse_dates","target_column":name,"evidence":f"{n} of {len(raw)} values parse as dates across mixed formats"})
        dups = int(series.loc[series.notna()].duplicated().sum())
        if dups and any(x in low for x in ("email","phone","customer","client","lead","account","order","id")): out.append({"id":iid("remove_duplicates",name),"action_type":"remove_duplicates","target_column":name,"evidence":f"{dups} duplicate non-empty values detected in a likely key field"})
    rank={"remove_duplicates":0,"standard_phone":1,"normalize_email":2,"parse_dates":3,"trim_whitespace":4,"remove_empty_rows":5}
    return sorted(out, key=lambda x:rank[x["action_type"]])[:12]


def profiles(df: pd.DataFrame) -> list[dict]:
    total=max(len(df),1); out=[]
    for col in df.columns:
        s=df[col]; samples=[]
        for v in s.dropna().head(5):
            x=sig(v)
            if x not in samples: samples.append(x)
        out.append({"column":str(col),"dtype":str(s.dtype),"null_count":int(s.isna().sum()),"null_rate":round(float(s.isna().sum())/total,4),"unique_count":int(s.nunique(dropna=True)),"format_signatures":samples[:4]})
    return out


def fallback(cs: list[dict]) -> dict:
    labels={
      "remove_duplicates":("Duplicate records in a key field","Duplicate customer or lead records can create repeated outreach, inaccurate counts, and conflicting ownership."),
      "standard_phone":("Inconsistent phone formatting","Inconsistent phone values can break CRM imports, click-to-call, deduplication, and SMS targeting."),
      "normalize_email":("Email values need normalization","Email casing and whitespace can cause false duplicates, failed matching, and inaccurate customer counts."),
      "parse_dates":("Mixed date formatting","Mixed date formats can break sorting, aging calculations, automation, and reporting."),
      "trim_whitespace":("Hidden whitespace in text values","Hidden spaces can make identical values compare differently and break joins, filters, and imports."),
      "remove_empty_rows":("Completely empty rows","Blank rows add noise and can disrupt imports or row-based automation.")}
    issues=[]
    for c in cs[:5]:
        title,risk=labels[c["action_type"]]; issues.append({"id":c["id"],"issue_title":title,"business_risk":risk,"python_fix_type":c["action_type"],"target_column":c["target_column"]})
    return {"industry_detected":"General Business Data","business_impact_summary":"PowerSnap found measurable data-quality patterns that can interfere with matching, reporting, imports, or customer outreach." if issues else "No high-confidence automatic cleanup issue was detected.","issues":issues}


def audit(df: pd.DataFrame, cs: list[dict]) -> dict:
    if not cs or not os.getenv("OPENAI_API_KEY") or OpenAI is None: return fallback(cs)
    payload={"headers":[str(c) for c in df.columns],"rows":len(df),"column_profiles":profiles(df),"candidate_issues":cs}
    try:
        r=OpenAI().chat.completions.create(model=MODEL,temperature=.2,response_format={"type":"json_schema","json_schema":SCHEMA},messages=[{"role":"system","content":PROMPT},{"role":"user","content":json.dumps(payload,separators=(",",":"))}])
        result=json.loads(r.choices[0].message.content or "{}")
    except Exception: return fallback(cs)
    allowed={c["id"]:c for c in cs}; safe=[]
    for x in result.get("issues",[]):
        c=allowed.get(x.get("id"))
        if c and x.get("python_fix_type")==c["action_type"] and x.get("target_column")==c["target_column"]: safe.append(x)
    if not safe: return fallback(cs)
    result["issues"]=safe[:5]; return result


def apply_fix(df: pd.DataFrame, action: str, col: str):
    if action not in ACTIONS: raise HTTPException(400,"Unsupported cleanup action")
    if action=="remove_empty_rows":
        m=df.isna().all(axis=1); n=int(m.sum()); return df.loc[~m].copy(),n,f"Removed {n} completely empty rows."
    if col not in df.columns: raise HTTPException(400,"Target column no longer exists")
    s=df[col]
    if action in {"trim_whitespace","normalize_email","standard_phone"}:
        u=s.copy(); m=s.notna(); text=s.loc[m].astype(str)
        if action=="trim_whitespace": text=text.str.strip(); label="Trimmed hidden whitespace"
        elif action=="normalize_email": text=text.str.strip().str.lower(); label="Normalized email formatting"
        else: text=text.str.replace(r"\D","",regex=True); label="Standardized phone formatting"
        u.loc[m]=text; n=int((s.astype(str)!=u.astype(str)).sum()); df[col]=u; return df,n,f"{label} in {n} values."
    if action=="parse_dates":
        parsed=pd.to_datetime(s,errors="coerce",format="mixed"); m=s.notna()&parsed.notna(); u=s.copy(); u.loc[m]=parsed.loc[m].dt.strftime("%Y-%m-%d"); n=int((s.astype(str)!=u.astype(str)).sum()); df[col]=u; return df,n,f"Standardized {n} parseable date values to YYYY-MM-DD."
    m=s.notna()&df.duplicated(subset=[col],keep="first"); n=int(m.sum()); return df.loc[~m].copy(),n,f"Removed {n} duplicate rows using '{col}' as the matching key."


def manifest(fid: str) -> dict:
    p=sdir(fid)/"manifest.json"
    if not p.exists(): raise HTTPException(404,"File session expired or not found")
    return json.loads(p.read_text())


def sign(fid: str, exp: int) -> str:
    secret=os.getenv("DOWNLOAD_SIGNING_SECRET")
    if not secret: raise HTTPException(503,"Download signing is not configured")
    payload=f"{fid}.{exp}"; mac=hmac.new(secret.encode(),payload.encode(),hashlib.sha256).hexdigest(); return f"{payload}.{mac}"


def verify(token: str, fid: str):
    secret=os.getenv("DOWNLOAD_SIGNING_SECRET")
    if not secret: raise HTTPException(503,"Download signing is not configured")
    try: tfid,raw,mac=token.split(".",2); exp=int(raw)
    except Exception: raise HTTPException(401,"Invalid download token")
    expected=hmac.new(secret.encode(),f"{tfid}.{exp}".encode(),hashlib.sha256).hexdigest()
    if tfid!=fid or exp<int(time.time()) or not hmac.compare_digest(mac,expected): raise HTTPException(401,"Download token expired or invalid")


@app.get("/health")
def health(): return {"status":"ok","service":"PowerSnap API"}

@app.post("/analyze")
async def analyze(file: UploadFile=File(...)):
    cleanup(); name=Path(file.filename or "uploaded.csv").name
    if not name.lower().endswith(".csv"): raise HTTPException(400,"PowerSnap currently accepts CSV files only")
    fid=secrets.token_hex(16); d=sdir(fid); d.mkdir(); path=d/"original.csv"; size=0
    try:
        with path.open("wb") as out:
            while chunk:=await file.read(1024*1024):
                size+=len(chunk)
                if size>MAX_MB*1024*1024: raise HTTPException(413,f"File exceeds {MAX_MB} MB limit")
                out.write(chunk)
        df=read_csv(path); cs=candidates(df); result=audit(df,cs); byid={c["id"]:c for c in cs}; issues=[]
        for x in result["issues"]:
            x["evidence"]=byid.get(x["id"],{}).get("evidence"); issues.append(x)
        m={"file_id":fid,"filename":name,"created_at":int(time.time()),"issues":issues}; (d/"manifest.json").write_text(json.dumps(m))
        return {"file_id":fid,"filename":name,"rows":len(df),"columns":len(df.columns),"industry_detected":result["industry_detected"],"business_impact_summary":result["business_impact_summary"],"issues":issues}
    except Exception:
        if not (d/"manifest.json").exists(): shutil.rmtree(d,ignore_errors=True)
        raise

@app.post("/clean")
def clean(file_id: str=Form(...), issue_id: str=Form(...)):
    cleanup(); m=manifest(file_id); issue=next((x for x in m["issues"] if x["id"]==issue_id),None)
    if not issue: raise HTTPException(400,"Unknown or expired audit issue")
    d=sdir(file_id); src=d/"cleaned.csv" if (d/"cleaned.csv").exists() else d/"original.csv"; df=read_csv(src)
    df,n,summary=apply_fix(df,issue["python_fix_type"],issue["target_column"]); df.to_csv(d/"cleaned.csv",index=False); os.utime(d,None)
    preview=df.head(5).where(pd.notna(df.head(5)),None).to_dict(orient="records")
    return {"file_id":file_id,"status":"success","fix":{"issue_id":issue_id,"action_type":issue["python_fix_type"],"target_column":issue["target_column"],"changed_rows":n,"summary":summary},"preview_rows":preview,"download_locked":True}

@app.post("/checkout")
def checkout(body: dict):
    fid=body.get("file_id",""); manifest(fid)
    if not (sdir(fid)/"cleaned.csv").exists(): raise HTTPException(400,"Apply at least one fix before checkout")
    if stripe is None or not os.getenv("STRIPE_SECRET_KEY") or not os.getenv("STRIPE_PRICE_ID"): raise HTTPException(503,"Billing is not configured")
    stripe.api_key=os.environ["STRIPE_SECRET_KEY"]
    x=stripe.checkout.Session.create(mode="subscription",line_items=[{"price":os.environ["STRIPE_PRICE_ID"],"quantity":1}],success_url=f"{FRONTEND_URL}/?checkout=success&session_id={{CHECKOUT_SESSION_ID}}&file_id={quote(fid)}",cancel_url=f"{FRONTEND_URL}/?checkout=cancelled&file_id={quote(fid)}",metadata={"powersnap_file_id":fid},subscription_data={"metadata":{"powersnap_file_id":fid}},allow_promotion_codes=True)
    return {"checkout_url":x.url}

@app.post("/download/authorize")
def authorize(body: dict):
    fid,sid=body.get("file_id",""),body.get("checkout_session_id",""); manifest(fid)
    if stripe is None or not os.getenv("STRIPE_SECRET_KEY"): raise HTTPException(503,"Billing is not configured")
    stripe.api_key=os.environ["STRIPE_SECRET_KEY"]; x=stripe.checkout.Session.retrieve(sid)
    if (x.metadata or {}).get("powersnap_file_id")!=fid: raise HTTPException(403,"Checkout session does not match this file")
    if x.status!="complete" or x.payment_status not in {"paid","no_payment_required"}: raise HTTPException(402,"Checkout is not complete")
    token=sign(fid,int(time.time())+900); return {"download_url":f"/download/{fid}?token={quote(token)}","expires_in_seconds":900}

@app.get("/download/{file_id}")
def download(file_id: str, token: str):
    verify(token,file_id); m=manifest(file_id); p=sdir(file_id)/"cleaned.csv"
    if not p.exists(): raise HTTPException(404,"Cleaned file expired")
    return FileResponse(p,media_type="text/csv",filename=f"{Path(m['filename']).stem}_powersnap_cleaned.csv")

@app.post("/dev/unlock")
def dev_unlock(body: dict, x_dev_key: str|None=Header(default=None)):
    expected=os.getenv("POWERSNAP_DEV_UNLOCK_KEY")
    if not expected or not x_dev_key or not secrets.compare_digest(expected,x_dev_key): raise HTTPException(404,"Not found")
    fid=body.get("file_id",""); manifest(fid); token=sign(fid,int(time.time())+900); return {"download_url":f"/download/{fid}?token={quote(token)}","expires_in_seconds":900}

@app.get("/", response_class=HTMLResponse)
def home():
    return HTMLResponse((Path(__file__).parent/"index.html").read_text())
