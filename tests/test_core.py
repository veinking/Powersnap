import os,time
os.environ.setdefault("DOWNLOAD_SIGNING_SECRET","test-secret")
import pandas as pd, pytest
from fastapi import HTTPException
from app import apply_fix,candidates,sign,verify

def test_detects_common_issues():
    df=pd.DataFrame({"Email":[" A@EXAMPLE.COM ","a@example.com","b@example.com"],"Phone":["(703) 555-1212","703-555-1212","7035559999"],"Created Date":["08/01/2026","2026-08-02","bad"]})
    found={(x["action_type"],x["target_column"]) for x in candidates(df)}
    assert ("normalize_email","Email") in found and ("standard_phone","Phone") in found and ("parse_dates","Created Date") in found

def test_duplicate_fix_preserves_nulls():
    df=pd.DataFrame({"Email":["a@test.com","a@test.com",None,None,"b@test.com"]}); clean,n,_=apply_fix(df,"remove_duplicates","Email")
    assert n==1 and len(clean)==4 and clean["Email"].isna().sum()==2

def test_dates_preserve_bad_values():
    df=pd.DataFrame({"Date":["8/1/2026","2026-08-02","unknown"]}); clean,_,_=apply_fix(df,"parse_dates","Date")
    assert clean.loc[0,"Date"]=="2026-08-01" and clean.loc[2,"Date"]=="unknown"

def test_signed_download_token():
    token=sign("a"*32,int(time.time())+30); verify(token,"a"*32)
    with pytest.raises(HTTPException): verify(sign("a"*32,int(time.time())-1),"a"*32)
