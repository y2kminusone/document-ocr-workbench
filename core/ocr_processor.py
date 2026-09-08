
import requests
import json
import os
import base64
import io
import numpy as np
from PIL import Image
from openai import OpenAI
from datetime import datetime
import traceback
import re
import hashlib

# Local endpoints are configurable; no company credentials are distributed.
YOLO_SERVER_URL = os.getenv("YOLO_SERVER_URL", "http://127.0.0.1:8011")
VLM_FALLBACKS = [
    {"name": "primary", "base_url": os.getenv("VLM_BASE_URL", "http://127.0.0.1:8000/v1"),
     "api_key": os.getenv("VLM_API_KEY", "not-configured"),
     "model": os.getenv("VLM_CURRENT_MODEL", "LLM-27B")},
    {"name": "fallback", "base_url": os.getenv("VLM_BASE_URL", "http://127.0.0.1:8000/v1"),
     "api_key": os.getenv("VLM_API_KEY", "not-configured"),
     "model": os.getenv("VLM_FALLBACK_MODEL", "LLM-122B")},
]
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://127.0.0.1:8000/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "not-configured")

# ==================== 헬퍼 함수 ====================
def pil_to_data_url(image, format='PNG'):
    """PIL Image를 base64 data URL로 변환"""
    buffered = io.BytesIO()
    image.save(buffered, format=format)
    img_str = base64.b64encode(buffered.getvalue()).decode()
    return f"data:image/{format.lower()};base64,{img_str}"

def base64_to_pil(base64_str):
    """Base64 data URL을 PIL Image로 변환"""
    if base64_str.startswith("data:image"):
        base64_str = base64_str.split(",")[1]
    image_data = base64.b64decode(base64_str)
    return Image.open(io.BytesIO(image_data))

def call_vlm_api_with_config(image_url, prompt, vlm_config):
    """특정 VLM 설정으로 API 호출"""
    import time
    import threading
    import datetime
    
    start_time = time.time()
    first_chunk_time = None
    chunk_count = 0
    timeout_occurred = False
    first_chunks = []  # 처음 3개 청크 저장
    last_chunks = []   # 마지막 3개 청크 저장
    full_response = []  # 전체 응답 저장
    
    def timeout_handler():
        nonlocal timeout_occurred
        timeout_occurred = True
        elapsed = time.time() - start_time
        print(f"[VLM][{vlm_config['name']}] 타임아웃 발생: {elapsed:.2f}초, 청크 수: {chunk_count}")
        if first_chunk_time:
            print(f"[VLM][{vlm_config['name']}] 첫 번째 청크 도착 후: {elapsed - first_chunk_time:.2f}초")
        else:
            print(f"[VLM][{vlm_config['name']}] 첫 번째 청크 도착하지 않음")
        
        # 청크 내용 로그
        if first_chunks:
            print(f"[VLM][{vlm_config['name']}] 처음 3개 청크 내용:")
            for i, chunk in enumerate(first_chunks, 1):
                print(f"[VLM][{vlm_config['name']}]   청크 {i}: {chunk[:100]}..." if len(chunk) > 100 else f"[VLM][{vlm_config['name']}]   청크 {i}: {chunk}")
        if last_chunks:
            print(f"[VLM][{vlm_config['name']}] 마지막 3개 청크 내용:")
            for i, chunk in enumerate(last_chunks, 1):
                print(f"[VLM][{vlm_config['name']}]   청크 {i}: {chunk[:100]}..." if len(chunk) > 100 else f"[VLM][{vlm_config['name']}]   청크 {i}: {chunk}")
    
    timer = threading.Timer(300, timeout_handler)  # 5분 타임아웃
    timer.start()
    
    try:
        print(f"[VLM][{vlm_config['name']}] 요청 시작: model={vlm_config['model']}")
        client = OpenAI(base_url=vlm_config['base_url'], api_key=vlm_config['api_key'])
        completion = client.chat.completions.create(
            model=vlm_config['model'],
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_url}},
                    {"type": "text", "text": prompt}
                ]
            }],
            temperature=0.000001,
            top_p=0.1,
            stream=True
        )
        
        response_text = ""
        for chunk in completion:
            if timeout_occurred:
                break
                
            if chunk.choices[0].delta.content:
                chunk_content = chunk.choices[0].delta.content
                
                # 첫 번째 청크 도착 시 로그
                if first_chunk_time is None:
                    first_chunk_time = time.time()
                    first_chunk_latency = first_chunk_time - start_time
                    print(f"[VLM][{vlm_config['name']}] 첫 번째 청크 도착: {first_chunk_latency:.2f}초")
                    print(f"[VLM][{vlm_config['name']}] 첫 번째 청크 내용: {chunk_content[:200]}..." if len(chunk_content) > 200 else f"[VLM][{vlm_config['name']}] 첫 번째 청크 내용: {chunk_content}")
                
                # 청크 저장
                if len(first_chunks) < 3:
                    first_chunks.append(chunk_content)
                else:
                    last_chunks.append(chunk_content)
                    if len(last_chunks) > 3:
                        last_chunks.pop(0)
                
                response_text += chunk_content
                chunk_count += 1
                full_response.append(chunk_content)  # 전체 응답 저장
                
                # 10초마다 진행 상황 로그
                if chunk_count % 10 == 0:
                    elapsed = time.time() - start_time
                    print(f"[VLM][{vlm_config['name']}] 진행 중: {elapsed:.2f}초, 청크 수: {chunk_count}, 현재 응답 길이: {len(response_text)}자")
        
        timer.cancel()
        
        if not timeout_occurred:
            total_time = time.time() - start_time
            print(f"[VLM][{vlm_config['name']}] 완료: 총 {total_time:.2f}초, 청크 수: {chunk_count}, 응답 길이: {len(response_text)}자")
            
            # 마지막 청크 내용 로그
            if last_chunks:
                print(f"[VLM][{vlm_config['name']}] 마지막 청크 내용: {last_chunks[-1][:200]}..." if len(last_chunks[-1]) > 200 else f"[VLM][{vlm_config['name']}] 마지막 청크 내용: {last_chunks[-1]}")
            
            # 전체 응답을 파일로 저장
            try:
                current_time = datetime.now()
                timestamp = current_time.strftime("%Y%m%d_%H%M%S")
                filename = f"vlm_response_{vlm_config['model']}_{timestamp}.txt"
                filepath = os.path.join(os.path.dirname(__file__), "..", "logs", filename)
                
                # logs 디렉토리가 없으면 생성
                os.makedirs(os.path.dirname(filepath), exist_ok=True)
                
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(f"=== VLM Response Log ===\n")
                    f.write(f"Model: {vlm_config['model']}\n")
                    f.write(f"Timestamp: {current_time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                    f.write(f"Total Time: {total_time:.2f}초\n")
                    f.write(f"Chunk Count: {chunk_count}\n")
                    f.write(f"Response Length: {len(response_text)}자\n")
                    f.write(f"\n=== Full Response ===\n")
                    f.write(response_text)
                    f.write(f"\n=== Chunks Detail ===\n")
                    for i, chunk in enumerate(full_response, 1):
                        f.write(f"\n--- Chunk {i} ---\n")
                        f.write(chunk)
                
                print(f"[VLM][{vlm_config['name']}] 전체 응답 저장 완료: {filepath}")
            except Exception as e:
                print(f"[VLM][{vlm_config['name']}] 응답 파일 저장 실패: {e}")
        
        return response_text.strip()
    except Exception as e:
        timer.cancel()
        elapsed = time.time() - start_time
        print(f"[VLM][{vlm_config['name']}] 에러 발생: {elapsed:.2f}초, 청크 수: {chunk_count}, 에러: {e}")
        
        # 청크 내용 로그
        if first_chunks:
            print(f"[VLM][{vlm_config['name']}] 처음 3개 청크 내용:")
            for i, chunk in enumerate(first_chunks, 1):
                print(f"[VLM][{vlm_config['name']}]   청크 {i}: {chunk[:100]}..." if len(chunk) > 100 else f"[VLM][{vlm_config['name']}]   청크 {i}: {chunk}")
        if last_chunks:
            print(f"[VLM][{vlm_config['name']}] 마지막 3개 청크 내용:")
            for i, chunk in enumerate(last_chunks, 1):
                print(f"[VLM][{vlm_config['name']}]   청크 {i}: {chunk[:100]}..." if len(chunk) > 100 else f"[VLM][{vlm_config['name']}]   청크 {i}: {chunk}")
        
        raise

def call_vlm_api(image_url, prompt):
    """VLM API 호출 (이미지 + 텍스트) - Fallback 지원"""
    for vlm_config in VLM_FALLBACKS:
        try:
            print(f"[VLM] {vlm_config['name']} 시도 중...")
            return call_vlm_api_with_config(image_url, prompt, vlm_config)
        except Exception as e:
            print(f"[VLM] {vlm_config['name']} 실패: {e}")
            if vlm_config != VLM_FALLBACKS[-1]:  # 마지막 fallback이 아니면 계속
                print(f"[VLM] 다음 fallback으로 시도...")
                continue
            else:
                print(f"[VLM] 모든 VLM fallback 실패")
                raise

def call_llm_api(prompt):
    """LLM API 호출 (텍스트만)"""
    import time
    import threading
    
    start_time = time.time()
    first_chunk_time = None
    chunk_count = 0
    timeout_occurred = False
    first_chunks = []  # 처음 3개 청크 저장
    last_chunks = []   # 마지막 3개 청크 저장
    
    def timeout_handler():
        nonlocal timeout_occurred
        timeout_occurred = True
        elapsed = time.time() - start_time
        print(f"[LLM] 타임아웃 발생: {elapsed:.2f}초, 청크 수: {chunk_count}")
        if first_chunk_time:
            print(f"[LLM] 첫 번째 청크 도착 후: {elapsed - first_chunk_time:.2f}초")
        else:
            print(f"[LLM] 첫 번째 청크 도착하지 않음")
        
        # 청크 내용 로그
        if first_chunks:
            print(f"[LLM] 처음 3개 청크 내용:")
            for i, chunk in enumerate(first_chunks, 1):
                print(f"[LLM]   청크 {i}: {chunk[:100]}..." if len(chunk) > 100 else f"[LLM]   청크 {i}: {chunk}")
        if last_chunks:
            print(f"[LLM] 마지막 3개 청크 내용:")
            for i, chunk in enumerate(last_chunks, 1):
                print(f"[LLM]   청크 {i}: {chunk[:100]}..." if len(chunk) > 100 else f"[LLM]   청크 {i}: {chunk}")
    
    timer = threading.Timer(300, timeout_handler)  # 5분 타임아웃
    timer.start()
    
    try:
        client = OpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)
        completion = client.chat.completions.create(
            model=os.getenv("LLM_MODEL", "your-text-model"),
            messages=[{
                "role": "user",
                "content": [{"type": "text", "text": prompt}]
            }],
            temperature=0.000001,
            top_p=0.1,
            stream=True
        )
        
        response_text = ""
        for chunk in completion:
            if timeout_occurred:
                break
                
            if chunk.choices[0].delta.content:
                chunk_content = chunk.choices[0].delta.content
                
                # 첫 번째 청크 도착 시 로그
                if first_chunk_time is None:
                    first_chunk_time = time.time()
                    first_chunk_latency = first_chunk_time - start_time
                    print(f"[LLM] 첫 번째 청크 도착: {first_chunk_latency:.2f}초")
                    print(f"[LLM] 첫 번째 청크 내용: {chunk_content[:200]}..." if len(chunk_content) > 200 else f"[LLM] 첫 번째 청크 내용: {chunk_content}")
                
                # 청크 저장
                if len(first_chunks) < 3:
                    first_chunks.append(chunk_content)
                else:
                    last_chunks.append(chunk_content)
                    if len(last_chunks) > 3:
                        last_chunks.pop(0)
                
                response_text += chunk_content
                chunk_count += 1
                
                # 10초마다 진행 상황 로그
                if chunk_count % 10 == 0:
                    elapsed = time.time() - start_time
                    print(f"[LLM] 진행 중: {elapsed:.2f}초, 청크 수: {chunk_count}, 현재 응답 길이: {len(response_text)}자")
        
        timer.cancel()
        
        if not timeout_occurred:
            total_time = time.time() - start_time
            print(f"[LLM] 완료: 총 {total_time:.2f}초, 청크 수: {chunk_count}, 응답 길이: {len(response_text)}자")
            
            # 마지막 청크 내용 로그
            if last_chunks:
                print(f"[LLM] 마지막 청크 내용: {last_chunks[-1][:200]}..." if len(last_chunks[-1]) > 200 else f"[LLM] 마지막 청크 내용: {last_chunks[-1]}")
        
        return response_text.strip()
    except Exception as e:
        timer.cancel()
        elapsed = time.time() - start_time
        print(f"[LLM] 에러 발생: {elapsed:.2f}초, 청크 수: {chunk_count}, 에러: {e}")
        
        # 청크 내용 로그
        if first_chunks:
            print(f"[LLM] 처음 3개 청크 내용:")
            for i, chunk in enumerate(first_chunks, 1):
                print(f"[LLM]   청크 {i}: {chunk[:100]}..." if len(chunk) > 100 else f"[LLM]   청크 {i}: {chunk}")
        if last_chunks:
            print(f"[LLM] 마지막 3개 청크 내용:")
            for i, chunk in enumerate(last_chunks, 1):
                print(f"[LLM]   청크 {i}: {chunk[:100]}..." if len(chunk) > 100 else f"[LLM]   청크 {i}: {chunk}")
        
        raise

def ai(*args):
    """통합 AI 함수 (이미지+텍스트 또는 텍스트만)"""
    if len(args) == 2:
        # 이미지 + 프롬프트 (VLM)
        return call_vlm_api(args[0], args[1])
    elif len(args) == 1:
        # 텍스트만 (LLM)
        return call_llm_api(args[0])
    else:
        raise ValueError("ai() 함수는 1개 또는 2개의 인자를 받아야 합니다.")

def call_yolo_server(image_path, rotation=None):
    """YOLO 서버에 이미지 전송하고 crop된 이미지들 반환"""
    try:
        with open(image_path, "rb") as f:
            files = {"file": (os.path.basename(image_path), f, "image/png")}
            data = {}
            if rotation:
                data["rotation"] = rotation
            
            response = requests.post(
                f"{YOLO_SERVER_URL}/detect",
                files=files,
                data=data,
                timeout=60
            )
        
        if response.status_code == 200:
            return response.json()
        else:
            raise Exception(f"YOLO 서버 오류: {response.status_code} - {response.text}")
    except Exception as e:
        raise Exception(f"YOLO 서버 호출 실패: {str(e)}")

# ==================== 프롬프트 상수 ====================
PROMPT_CHEM_MULTI = """
- HEAT CHEMICAL ANALYSIS 를 제외한 화학조성테이블을 모두 markdown으로 뽑아줘
- Min, Max가 포함된 행은 무시해줘. 
"""

PROMPT_CHEM_SINGLE = """
- 이미지에 존재하는 화학 조성 Column을 정확하게 추출해줘.   
- 컬럼명은 정확하게 이미지에 존재하는 컬럼명만 추출해줘.
- 제일 처음에 이미지에 존재하는 **컬럼명을 제외한 숫자** 데이터가 존재하는 행 개수를 세고, 그 행 개수만큼 데이터를 뽑아서 markdown 으로 만들어.
- 이미지에서 보이는 그대로 화학 조성만 Column으로 구성해서 만들어줘.
- 만약 데이터에 BM 또는 WM 이 존재하면 BM/WM 라는 이름의 컬럼을 만들어서 거기에 넣어줘.
- 만약 데이터에 L 또는 C가 존재하면 Division 이라는 컬럼을 만들어서 거기에 넣어줘.
- 화학조성 데이터에 공백이 존재하면 반영해줘 
 <example>
 |  C  | Si | O | B | Mn |
 | 32  | 1  |   | 5 | 22 |
- 절대 화학 조성 비율 (%) 로 변환하지마.
- 화학 원소 기호에 있는 숫자 중 min이나 max가 존재하는 행은 무시해.
- 반드시 하나의 markdown 테이블로 출력해줘.
- 아까전에 숫자 데이터가 존재하는 행 개수를 출력했잖아? 만든 markdown 테이블의 행 개수와 똑같은지 확인하고 개수가 정확하게 맞아야해
"""

PROMPT_CHEM_WITH_HEAT = """
- 이미지에 존재하는 화학 조성 Column을 정확하게 추출해줘.   
- markdown 테이블로 만들기 전에, 각 열에 대응하는 데이터가 어떤것들이 있는지 전부 출력해줘.
- 컬럼명은 정확하게 이미지에 존재하는 컬럼명만 추출해줘.
- 화학 조성 데이터에 0이 존재하는 경우에도 모두 markdown 으로 만들어야돼.
- 이미지에서 보이는 그대로 화학 조성만 Column으로 구성해서 만들어줘.
- (Crucial) 화학조성 데이터에 공백이 존재한다면 공백도 반영해서 markdown 테이블을 만들어줘.
- 절대 화학 조성 비율 (%) 로 변환하지마.
- 화학 원소 기호에 있는 숫자 중 min이나 max가 존재하는 행은 무시해.
- 0의 개수를 정확하게 파악해서 이미지와 동일한 위치에 데이터를 넣는것이 매우 중요한 task야.
- 반드시 하나의 markdown 테이블로 출력해줘.
- 만약 추출한 Heat No.가 존재한다면 markdown 테이블의 왼쪽에 붙여서 병합해줘.
- (Crucial) 데이터가 중복되는 행이 있어도 반드시 전부 markdown 테이블로 만들어야돼
"""

PROMPT_LADLE_PRODUCT_CHECK = """
이미지에서 Ladle과 product라는 정확한 단어가 존재하는지 확인해보고, 둘 다 존재하는 경우에는
Yes 를 , 둘 중에 하나라도 존재하지 않는 경우에는 No를 출력해줘.
L, P 는 Ladle 과 Product가 아니야.
출력은 반드시 Yes , No로만 답해
"""

PROMPT_HEAT_EXIST_CHECK = "이미지에서 Heat No 가 존재하는지 알려줘. 출력은 Yes, No로만 답변해."

PROMPT_HEAT_EXIST_CHECK_IN_TEXT = """
{markdown_text} 에 Heat No라는 단어가 하나라도 존재하는지 체크해봐.
출력은 하나라도 존재한다면 Yes, 한개도 존재하지 않는다면 No로 출력해.
출력은 반드시 Yes , No로만 답변해야돼.
"""

PROMPT_HEAT_EXTRACT = """
- 이미지에서 Heat No를 정확하게 추출해줘.(중복되도 생략하지 말고 순서대로 다 뽑아줘.)
- 추출한 Heat No가 이미지에 Heat No에서 추출한것인지 한번 더 확인해줘
- Min,Max가 포함된 행은 무시해줘.
- Min,Max가 포함된 행이 존재한다면 그 행의 아래에 위치한 행만 추출해줘.
- 만약 HeatNo가 / 기호로 나누어져있다면 앞부분이 HeatNo야.
"""

PROMPT_ALL_EXTRACT = """
이미지에서 아래에 해당하는 정보만 추출하세요.
- DWG No. (존재하는 경우에만 컬럼명 출력)
- Discription (존재하는 경우에만 컬럼명으로 출력. Description은 아님.)
- CMTR No. (존재하는 경우에만 컬럼명 출력)
- Heat/Lot No, Heat No. (존재하는 경우 Heat No 컬럼명으로 출력)
- Spool Tag No. (존재하는 경우에만 컬럼명 출력)
- Heat No. (중복되도 출력)
- Heat No. 는 공백일 수 없어.
- CMTR Page (존재하는 경우에만 컬럼명 출력)
- HCN (존재하는 경우에만 컬럼명 출력)
- 만약 Heat No.와 HCN이 한 컬럼에 구분기호(ex.: /)로 나누어져 들어간 경우, 두개를 분리해서 각각 컬럼으로 만들어줘.
- 예제를 참고해서 Markdown 을 만들어주는데, 컬럼명은 이미지에 존재하는것만 만들어줘.
"""

PROMPT_CHEM_DOUBLECHECK_TEMPLATE = """
이 프롬프트는 Chemical 이미지에서 추출한 1차 결과({response_chem_pre})를 
table 이미지를 참고하여 2차로 검증하고 정제하기 위한 단계야.

다음 규칙에 따라 수행해줘:

1. **검증 기준**
- {response_chem_pre}는 이미지에서 추출된 화학조성 markdown 테이블이야.
- table 이미지를 참고하여 실제 값과 비교하고 불필요하거나 잘못된 행을 제거해.

2. **행 처리 규칙**
- (Crucial) 행에 'min', 'max', 'Min', 'Max' 등의 단어가 포함되어 있다면 그 행 전체를 **삭제**해.
- 'x100', 'x1000' 등 단위 배율만 표시된 행도 **삭제**해.

- PRODUCT 바로 위나 아래의 min/max 행도 동일하게 삭제해.
- min/max가 없는 경우에는 기존 행을 그대로 **유지**해.

3. **열 처리 규칙**
- 데이터에 'L' 또는 'C'가 존재한다면 해당 컬럼명을 **Division**으로 변경해.
- 데이터가 모두 비어있는 열은 **유지하되**, 새로운 열을 추가하지마.
- 단위 배율(x100, x1000)만 있는 열은 삭제해.
- Tensile Test는 **무시**해

4. **정합성 및 수정**
- Chemical 테이블의 각 열을 table 이미지 기준으로 비교해 잘못된 값이 보이면 수정하되, 
  원본 숫자 포맷(소수점, 공백 등)은 그대로 유지해.
- 화학조성 데이터를 절대 %로 변환하지마.
- 모든 수정이 끝나면 유효한 숫자 데이터가 존재하는 행만 남겨야 해.

5. **출력 규칙**
  **최종 정제된 markdown 테이블 단 한 개만 출력해.**
- 중간 추론용 markdown 테이블은 절대 출력하지마.
"""

PROMPT_CHEM_PLUS_TEMPLATE = """
(Crucial) 이미지에서 heat No, HCN 추출해서, {response_chem}의 Markdown 테이블의 왼쪽에 붙여서 합쳐줘.
- {response_chem}의 모든 행은 반드시 markdown 테이블에 포함시켜, 사고과정에서도 몇 행이 존재하는지 말해야돼.
- 컬럼은 Heat No, HCN, Division(존재한다면) 주어진 markdown 테이블 이외에는 추가하지마.
- Raw Heat No.는 Heat No.와 동일. Lot No는 Heat No가 아님.
- (CRUCIAL) 반드시 화학 조성의 컬럼명은 {response_chem} markdown 테이블의 컬럼명과 동일하게 해줘.
- 절대 화학조성 데이터를 화학 조성 비율 (%) 로 변환하지마. 이미지에 보이는 숫자 그대로 유지.
- Empty Row는 추가하지마.
- 화면에 보이는 그대로의 테이블이 되도록 출력해줘.
"""

PROMPT_HEAT_PLUS_CHEM_TEMPLATE = """
{response_heat}과 {response_chem} 을 합쳐서 하나의 markdown 테이블로 만들어줘.
비어있는 컬럼은 비어있는 채로 두고 합쳐줘.
만약 Ladle Result 또는 MFG. No.와 같이 Heat No가 아닌 것이 {response_chem}과 함께있다면 추출한 Heat No를 별도 컬럼으로 만들어서 붙여줘.
만약 Lot No와 같이 Heat No가 아닌 것이 존재한다면 추출한 Heat No를 별도 컬럼으로 만들어서 붙여줘.
사고과정은 출력하지말고 Markdown 테이블만 출력해줘.
"""

PROMPT_CHEM_TO_JSON = """
{response}의 내용을 {json_fm}의 json 포맷을 참고해서 존재하는 열을 json으로 변환해줘.
{response}에 존재하는 컬럼만 변환해줘.
markdown 테이블의 열의 이름 및 내용을 전부 json 포맷으로 변환해줘.
일부 비어 있는 컬럼은 빈칸으로 하고 모든행 변환해줘. 
기존 데이터을 보내준 양식대로 그래로 옮겨만 줘. 
컬럼명에 특수문자 *,<<,>> 이 존재하면 없애고 옮겨줘.
만약 컬럼명이 특수문자 / 로 구분되어있다면 /을 기준으로 나눠서 각각 저장해줘.
예외로 BM/WM은 한 컬럼으로 출력해줘. 
json code만 출력해줘. 그리고 ```json 이나 ``` 같은건 출력하지말아줘.
(Crucial) 만약 마크다운 행 중에 min 또는 max 라는 문자가 포함되어 있는 행은 무시해줘.
(Crucial) 만약 어떤 행의 모든 데이터가 공백이면 그 행은 json 파싱에서 제외해줘, 그런데 HeatNo가 존재하는 행이라면 무조건 JSON으로 파싱해야돼.
파싱할때 데이터가 - 라면, 공백으로 바꿔서 파싱해줘.
(Crucial) 소수점 숫자 형식 정규화: 모든 소수점 숫자는 반드시 "0.XX" 형식으로 통일해야 해.
  - 예: "0,35" → "0.35"로 변환 (콤마를 점으로 변경)
  - 예: ".35" → "0.35"로 변환 (앞에 0 추가)
  - 예: "0.35" → "0.35" 유지 (이미 올바른 형식)
  - 예: "0,35"나 ".35" 같은 형식은 절대 그대로 출력하지 말고 반드시 "0.35"로 변환해.
  - 이 규칙은 모든 숫자 데이터에 적용해야 해.
만약 Spool Tag No. 열에 공백이 존재한다면 바로 위의 Spool Tag No.를 복사해줘.

# === 추가 부분 (열 이름 정규화 규칙) ===
(Crucial) markdown 테이블의 열 이름에 다음과 같은 변형이 존재할 경우 모두 표준화해줘:
- "Heat No", "Heat No.", "HeatNo", "Heat No / Raw", "Heat No/Raw", "Raw Heat No.", "Raw HeatNo", "Heat Number" 등은 전부 **Heat No** 로統一(통일)해.
- 대소문자, 마침표, 슬래시, 공백 여부와 관계없이 Heat No 계열은 Heat No 로 변환해.
- "HCN.", "H.C.N" 등은 **HCN**으로 통일.
- "SpoolTag", "Spool Tag No", "SpoolTagNo" 등은 **Spool Tag No.** 로 통일.
- "Division.", "Div", "Div." 등은 **Division** 으로 통일.
이 규칙에 따라 컬럼명을 정규화한 후 JSON 변환을 수행해.

# === (매우 중요) JSON 출력 형식 ===
(Crucial) 반드시 아래와 같은 형식으로 JSON을 출력해야 해:
{{
  "table": [
    {{
      "Heat No": "값",
      "HCN": "값",
      ...
    }},
    ...
  ]
}}

(Crucial) 절대 리스트 형태로 직접 출력하지 말고, 반드시 "table" 키 안에 리스트를 넣어야 해.
(Crucial) 최상위는 반드시 딕셔너리여야 하고, "table" 키가 있어야 해.
(Crucial) "table" 키의 값은 리스트여야 해.
(Crucial) 잘못된 예: [{"Heat No": "값", ...}]  (X)
(Crucial) 올바른 예: {{"table": [{"Heat No": "값", ...}]}}  (O)
"""

# ==================== 새로운 2단계 분류 프롬프트 ====================
PROMPT_PAGE_CLASSIFIER = """
이미지가 다음 중 어느 유형인지 하나만 선택해:

1. Traceability (CMTR, DWG No, Heat No 등의 정보가 있는 페이지)
   - [중요] 이 페이지 유형에는 화학 조성(Chemical Composition) 데이터가 절대 포함되지 않음.
   - 만약 C, Si, Mn, P, S 등 화학 원소 표나 데이터가 보인다면, 이 유형이 아님.

2. Chemical (C, Si, Mn, P, S 등 화학 조성 테이블이 있는 페이지)
   - [중요] 화학 원소 기호나 Composition 테이블이 보이면 무조건 이 유형임.

출력은 반드시 "Traceability" 또는 "Chemical" 둘 중 하나의 단어로만 답해.
"""

PROMPT_TRACEABILITY = """
이미지에서 Traceability / CMTR 정보만 추출해 JSON으로 출력해.

추출 대상:
- DWG No
- Discription (Description은 제외)
- Mat'l Spec
- CMTR No (Remark는 제외)
- Heat/Lot No, Heat No, Heat No. 는 모두 Heat No 로 추출
- CMTR Page

규칙:
- 반드시 JSON만 출력해. 코드펜스, 설명 금지.
- 형식: {"table":[{...}, {...}]}
- 보이는 컬럼만 추출해.
- min/max 행 제외.
- 빈 행 제외.
- Remark 데이터는 제외

열 이름 표준화:
- "DWG No", "DWG No.", "Drawing No", "Dwg No" -> "DWG No"
- "Discription" -> "Discription"
- "Mat'l Spec" -> "M Spec"
- "CMTR No", "CMTR No.", "CMTR" -> "CMTR No"
- "Heat/Lot No", "Heat No", "Heat No.", "HeatNo" -> "Heat No"
"""

PROMPT_CHEMICAL = """
이미지에서 Chemical Composition 정보만 추출해 JSON으로 출력해.

추출 대상:
- 화학조성 컬럼(C, Si, Mn, P, S, Cr, Ni, Mo, V, N, Cu 등)
- Heat No(=HEAT ID NO / != RAW HEAT NO), Mill Work No, HCN, Certificate No(성적서 번호), 제품명(=Nomenclature, Product And Size, Commodity), Division (보이는 경우)

규칙:
- 반드시 JSON만 출력해. 코드펜스, 설명 금지.
- 형식: {"table":[{...}, {...}]}
- 컬럼명에서 "X 1/100" 같은 배율 정보는 제거하고 기호(C, Si 등)만 사용해.
- 보이는 컬럼만 추출해.
- min/max 행 제외.
- 빈 행 제외.
- 값은 원문 그대로 유지 (단위 변환 금지).
- 모든 행에 대해 각 행에 Bend라는 열을 추가하여 회사 이름을 기록해.(Sung Kwang, Tae Kwang 등)

열 이름 표준화:
- "Heat/Lot No" "HEAT ID NO", "Heat No", "Heat No.", "HeatNo" -> "Heat No"
- "Mill Work No", "Mill Work No.", "MillWorkNo" -> "Mill Work No"
- "HCN.", "H.C.N" -> "HCN"
- "제품 명", "Nomenclature", "Product And Size", "Commodity" -> "Product"
- "Div", "Div.", "Division." -> "Division"
"""

# ==================== 기존 단일 패스 프롬프트 (주석 처리) ====================
# PROMPT_CHEM_SINGLE_PASS_JSON = """
# 이미지에서 아래 두 종류의 페이지 중 보이는 정보를 추출해 JSON 스키마로만 응답해.
# 
# 페이지 유형:
# 1. Traceability / CMTR 정보 페이지
# - (매우 중요) Traceability / CMTR 정보 페이지는 절대 화학 조성이 들어있지 않아. C, Si, Mn 등이 보인다면 페이지 유형 2로 작업해.
#    - DWG No
#    - Discription (Description은 제외)
#    - CMTR No
#    - Heat/Lot No, Heat No, Heat No. 는 모두 Heat No 로 추출
# 
# 2. Chemical Composition 페이지
#     - (매우 중요) Chemical Composition 페이지는 table 이미지 우측 상단에 "REF NO"라는 단어가 있을 확률이 매우 높아
#     - (매우 중요) "REF NO"가 있을시 매우 높은 확률로 "CHEMICAL COMPOSITION"이란 단어가 존재하고 그 아래에 화학 조성 데이터가 있어.
#    - (매우 중요) 화학조성 컬럼(C, Si, Mn, P, S, Cr, Ni, Mo, V, N, Cu 등)을 반드시 추출해내.
#    - 화학조성 컬럼은 "C", "C X 1/100", "Si", "Si X 1/100" 등 다양한 형태로 나타날 수 있지만, 모두 화학조성으로 취급하고 추출해
#    - 추출할 때는 컬럼명에서 "X 1/100" 같은 배율 정보를 제거하고 "C", "Si" 등 기본 원소 기호만 사용해
#    - Heat No, Mill Work No, HCN, Division 이 보이면 함께 추출
#    - (힌트1) 화학 조성 표는 "Chemical Composition"이라는 단어가 들어있는 테이블 아래 또는 옆에 위치해
#    - (중요) Chemical Composition 페이지에서는 화학조성, Heat No, Mill Work No만 추출하고, 그 외의 모든 컬럼은 절대 추출하지마
# 
# 공통 규칙:
# - 반드시 JSON만 출력해. 코드펜스, 설명, 사고과정은 출력하지마.
# - 형식은 반드시 {"table":[{...}, {...}]} 로 출력해.
# - 이미지에 실제로 보이는 컬럼만 포함해. 보이지 않는 컬럼은 만들지마.
# - 값은 이미지 원문 그대로 유지해. 임의 보정, 단위 변환, % 변환, 스케일 변환 금지.
# - min/max가 포함된 행은 제외해.
# - 빈 행은 제외해.
# - 한 행에 DWG No, Discription, CMTR No, Heat No가 같이 있으면 같은 JSON object에 넣어.
# - 화학조성 행에 Heat No, Mill Work No, HCN, Division이 같이 보이면 같은 JSON object에 넣어.
# - 페이지에 두 유형 정보가 모두 있으면 보이는 모든 관련 컬럼을 같은 table 안에 행 단위로 추출해.
# 
# 열 이름 표준화:
# - "DWG No", "DWG No.", "Drawing No", "Dwg No" 는 "DWG No" 로 통일
# - "Discription" 만 "Discription" 으로 추출 (Description은 제외)
# - "CMTR No", "CMTR No.", "CMTR", "C.M.T.R No" 는 "CMTR No" 로 통일
# - "Heat/Lot No", "Heat Lot No", "Heat No", "Heat No.", "HeatNo" 는 "Heat No" 로 통일
# - "Mill Work No", "Mill Work No.", "MillWorkNo" 는 "Mill Work No" 로 통일
# - "HCN.", "H.C.N" 은 "HCN" 으로 통일
# - "Div", "Div.", "Division." 은 "Division" 으로 통일
# """

# ==================== JSON 처리 함수 ====================
def json_handle(number):
    """JSON 스키마 생성 함수"""
    # 기본 JSON 스키마 템플릿 (124는 컬럼 수를 의미하는 것으로 보임)
    # 실제 구현은 노트북의 json_handle 함수를 참고해야 하지만,
    # 일단 기본 구조만 반환
    return json.dumps({
        "table": []
    }, indent=2, ensure_ascii=False)

def parse_json_response(response_text):
    """JSON 응답에서 실제 JSON 부분만 추출"""
    # ```json ... ``` 형태 제거
    response_text = response_text.strip()
    if response_text.startswith("```json"):
        response_text = response_text[7:]
    if response_text.startswith("```"):
        response_text = response_text[3:]
    if response_text.endswith("```"):
        response_text = response_text[:-3]
    return response_text.strip()

def normalize_decimal_format(value):
    """
    소수점 숫자 형식을 정규화하는 함수
    
    Args:
        value: 정규화할 값 (문자열, 숫자 등)
    
    Returns:
        정규화된 값
    """
    if value is None:
        return value
    
    # 문자열로 변환
    str_value = str(value).strip()
    
    # 빈 문자열이면 그대로 반환
    if not str_value:
        return str_value
    
    # 숫자가 아닌 경우 (Heat No, HCN 등) 그대로 반환
    # 소수점이나 콤마가 포함된 경우만 처리
    if '.' not in str_value and ',' not in str_value:
        return str_value
    
    # 콤마를 점으로 변환 (유럽식 소수점)
    normalized = str_value.replace(',', '.')
    
    # 점으로 시작하는 경우 앞에 0 추가 (예: .35 -> 0.35)
    if normalized.startswith('.'):
        normalized = '0' + normalized
    
    # 유효한 소수점 숫자인지 확인
    try:
        # 숫자로 변환 가능한지 확인
        float(normalized)
        return normalized
    except ValueError:
        # 변환 실패 시 원본 반환
        return str_value

def normalize_table_data(table):
    """
    테이블 데이터의 모든 숫자 값에 대해 소수점 형식을 정규화
    
    Args:
        table: 정규화할 테이블 데이터 (list of dict)
    
    Returns:
        정규화된 테이블 데이터
    """
    if not isinstance(table, list):
        return table
    
    normalized_table = []
    for row in table:
        if not isinstance(row, dict):
            normalized_table.append(row)
            continue
        
        normalized_row = {}
        for key, value in row.items():
            # 각 값에 대해 소수점 형식 정규화 적용
            normalized_row[key] = normalize_decimal_format(value)
        
        normalized_table.append(normalized_row)
    
    return normalized_table

# ==================== OCR 처리 클래스 ====================
class OCRProcessor:
    """OCR 처리 메인 클래스"""
    
    def __init__(self, progress_callback=None, log_callback=None):
        """
        Args:
            progress_callback: 진행 상황 콜백 함수 (message: str) -> None
            log_callback: 로그 콜백 함수 (message: str) -> None
        """
        self.progress_callback = progress_callback
        self.log_callback = log_callback
        self._image_url_cache = {}
        self._token_stats = {}
    
    def log(self, message):
        """로그 출력"""
        message = self._redact_image_urls(message)
        if self.log_callback:
            self.log_callback(message)
        else:
            print(message)
    
    def progress(self, message):
        """진행 상황 업데이트"""
        if self.progress_callback:
            self.progress_callback(message)
        self.log(message)

    def _safe_len(self, value):
        """None-safe 문자열 길이"""
        if value is None:
            return 0
        return len(str(value))

    def _log_ctx(self, branch, stage, prompt=None, response=None, image_url=None):
        """LLM/VLM 컨텍스트 길이 로깅"""
        self.log(
            f"[CTX] branch={branch} stage={stage} "
            f"prompt_len={self._safe_len(prompt)} "
            f"response_len={self._safe_len(response)} "
            f"image_url_len={self._safe_len(image_url)}"
        )

    def _redact_image_urls(self, text):
        """로그 문자열 내 data-url(base64) 및 일반 URL 제거"""
        if text is None:
            return ""
        redacted = re.sub(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]+", "<redacted:data-url-base64>", str(text))
        redacted = re.sub(
            r"(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/=])",
            "<redacted:base64>",
            redacted,
        )
        redacted = re.sub(r"https?://\S+", "<redacted:url>", redacted)
        return redacted

    def _estimate_tokens(self, value):
        """간이 토큰 추정치(약 4 chars/token)"""
        if value is None:
            return 0
        return max(1, self._safe_len(value) // 4)

    def _reset_token_stats(self):
        self._image_url_cache = {}
        self._token_stats = {
            "calls": 0,
            "prompt_tokens": 0,
            "image_tokens": 0,
            "response_tokens": 0,
        }

    def _add_token_stats(self, prompt=None, image_url=None, response=None, count_call=False):
        if count_call:
            self._token_stats["calls"] += 1
        self._token_stats["prompt_tokens"] += self._estimate_tokens(prompt)
        self._token_stats["image_tokens"] += self._estimate_tokens(image_url)
        self._token_stats["response_tokens"] += self._estimate_tokens(response)

    def _log_token_summary(self, branch):
        total = (
            self._token_stats.get("prompt_tokens", 0)
            + self._token_stats.get("image_tokens", 0)
            + self._token_stats.get("response_tokens", 0)
        )
        self.log(
            f"[CTX_SUMMARY] branch={branch} calls={self._token_stats.get('calls', 0)} "
            f"prompt_tokens={self._token_stats.get('prompt_tokens', 0)} "
            f"image_tokens={self._token_stats.get('image_tokens', 0)} "
            f"response_tokens={self._token_stats.get('response_tokens', 0)} total_tokens={total}"
        )

    def _get_cached_data_url(self, image, format='PNG'):
        """동일 이미지 입력 재사용을 위한 data_url 캐시"""
        buffered = io.BytesIO()
        image.save(buffered, format=format)
        raw = buffered.getvalue()
        key = hashlib.sha1(raw).hexdigest()
        cached = self._image_url_cache.get(key)
        if cached:
            return cached
        data_url = f"data:image/{format.lower()};base64,{base64.b64encode(raw).decode()}"
        self._image_url_cache[key] = data_url
        return data_url

    def _ai_call(self, branch, stage, prompt, image_url=None):
        """공통 AI 호출 + 단계별 토큰 로그"""
        self._log_ctx(branch=branch, stage=f"{stage}:before", prompt=prompt, image_url=image_url)
        self._add_token_stats(prompt=prompt, image_url=image_url, count_call=True)
        try:
            if image_url is None:
                response = ai(prompt)
            else:
                response = ai(image_url, prompt)
            self._log_ctx(branch=branch, stage=f"{stage}:after", response=response)
            self._add_token_stats(response=response)
            return response
        except Exception as e:
            redacted = self._redact_image_urls(e)
            self.log(f"[CTX_ERROR] branch={branch} stage={stage} error={redacted}")
            raise

    def _log_parse_fallback(self, branch, stage, exc, raw_text=None):
        """파싱 실패 시 빈 응답 반환 전에 상세 로그를 남긴다."""
        self.log(f"[PARSE_FALLBACK] branch={branch} stage={stage} error={self._redact_image_urls(exc)}")
        if raw_text is not None:
            text = self._redact_image_urls(raw_text)
            self.log(
                f"[PARSE_FALLBACK] branch={branch} stage={stage} raw_len={len(text)}"
            )
            self.log(
                f"[PARSE_FALLBACK] branch={branch} stage={stage} full_response=\n{text}"
            )

    def _log_empty_table_warning(self, branch, stage, raw_text=None, table_data=None):
        """파싱은 성공했지만 빈 테이블이 반환된 경우 로그를 남긴다."""
        self.log(f"[EMPTY_TABLE_WARNING] branch={branch} stage={stage} message='JSON 파싱 성공했지만 빈 테이블 반환'")
        if raw_text is not None:
            text = self._redact_image_urls(raw_text)
            self.log(
                f"[EMPTY_TABLE_WARNING] branch={branch} stage={stage} raw_len={len(text)}"
            )
            self.log(
                f"[EMPTY_TABLE_WARNING] branch={branch} stage={stage} full_response=\n{text}"
            )
        if table_data is not None:
            self.log(
                f"[EMPTY_TABLE_WARNING] branch={branch} stage={stage} parsed_data={json.dumps(table_data, ensure_ascii=False)}"
            )

    def _extract_table_from_json_result(self, json_text):
        result_data = json.loads(json_text)

        if isinstance(result_data, list):
            return result_data
        if isinstance(result_data, dict):
            table = result_data.get("table", [])
            return table if isinstance(table, list) else []
        return []

        # [B] OCRProcessor 내부 유틸 메서드 추가 (_extract_table_from_json_result 아래 권장)
    def _parse_table_from_ai_json(self, response_text):
        try:
            json_text = parse_json_response(response_text)
            data = json.loads(json_text)
            if isinstance(data, dict):
                table = data.get("table", [])
                return table if isinstance(table, list) else []
            if isinstance(data, list):
                return data
        except Exception as e:
            self.log(f"[FAST_PATH] JSON parse failed: {self._redact_image_urls(e)}")
        return []

    def _is_fast_table_valid(self, table):
        # 품질 게이트 기능 비활성화 - 항상 True 반환
        return True
        
        # 아래는 기존 품질 게이트 로직 (주석 처리)
        # if not isinstance(table, list) or not table:
        #     return False

        # rows = [r for r in table if isinstance(r, dict)]
        # if not rows:
        #     return False

        # signal_keys = {
        #     "DWG No", "Discription", "CMTR No",
        #     "Heat No", "HCN", "Division",
        #     "C", "Si", "Mn", "P", "S", "Cr", "Ni", "Mo", "V", "N", "Cu"
        # }
        # all_keys = set()
        # for r in rows:
        #     all_keys.update(r.keys())

        # # 품질 게이트: 의미 있는 컬럼이 최소 2개 이상
        # if len(all_keys & signal_keys) < 2:
        #     return False

        # # 품질 게이트: 값 밀도(너무 빈 테이블 방지)
        # total_cells = 0
        # non_empty_cells = 0
        # for r in rows:
        #     for v in r.values():
        #         total_cells += 1
        #         if str(v).strip() != "":
        #             non_empty_cells += 1
        # if total_cells == 0:
        #     return False
        # if (non_empty_cells / total_cells) < 0.15:
        #     return False

        # return True

    def classify_page(self, image_url):
        """페이지 유형을 판단하는 함수"""
        try:
            response = ai(image_url, PROMPT_PAGE_CLASSIFIER)
            result = response.strip().upper()
            
            if "TRACEABILITY" in result:
                self.log(f"[CLASSIFIER] 페이지 유형: Traceability")
                return "Traceability"
            elif "CHEMICAL" in result:
                self.log(f"[CLASSIFIER] 페이지 유형: Chemical")
                return "Chemical"
            else:
                # 모호할 경우 기본값 또는 재시도 로직 추가 가능
                self.log(f"[CLASSIFIER] 분류 모호함: {result} -> Traceability로 간주")
                return "Traceability"
                
        except Exception as e:
            self.log(f"[CLASSIFIER] 분류 실패: {e}")
            return "Traceability" # 에러 시 기본값

    def _try_single_pass_chemical_table(self, image_url):
        """2단계 분류 방식으로 페이지 유형 판단 후 데이터 추출 (최대 3회 재시도)"""
        self.progress("[CLASSIFIER] 페이지 유형 분류 중...")
        
        # 1. 분류 먼저 수행
        page_type = self.classify_page(image_url)
        
        # 2. 분류 결과에 따라 프롬프트 선택
        selected_prompt = ""
        if page_type == "Traceability":
            selected_prompt = PROMPT_TRACEABILITY
            self.progress("[CLASSIFIER] Traceability 프롬프트 선택")
        else:
            selected_prompt = PROMPT_CHEMICAL
            self.progress("[CLASSIFIER] Chemical 프롬프트 선택")
        
        # 3. 최대 3회 재시도하며 데이터 추출
        max_retries = 3
        for attempt in range(1, max_retries + 1):
            try:
                self.progress(f"[EXTRACT] 데이터 추출 중... (시도 {attempt}/{max_retries})")
                response = self._ai_call("with_chemical_fast", "two_step_extract", selected_prompt, image_url)
                table = self._parse_table_from_ai_json(response)
                
                # 품질 테스트 비활성화 - 항상 테이블 반환
                self.log(f"[FAST_PATH] accepted rows={len(table)} (시도 {attempt}/{max_retries})")
                return table
                
            except Exception as e:
                self.log(f"[FAST_PATH] JSON 파싱 실패 (시도 {attempt}/{max_retries}): {self._redact_image_urls(e)}")
                
                if attempt < max_retries:
                    self.progress(f"[FAST_PATH] JSON 파싱 실패 - 재시도 ({attempt + 1}/{max_retries})")
                    # 재시도 전 잠시 대기 (선택사항)
                    import time
                    time.sleep(0.5)
                else:
                    self.progress(f"[FAST_PATH] JSON 파싱 실패 - 최대 재시도 횟수 초과 ({max_retries}회)")
                    self.log(f"[FAST_PATH] 모든 재시도 실패, 빈 테이블 반환")
                    return []
        
        # ========== 기존 코드 (주석 처리) ==========
        # # 3. 선택된 프롬프트로 실행
        # self.progress("[EXTRACT] 데이터 추출 중...")
        # response = self._ai_call("with_chemical_fast", "two_step_extract", selected_prompt, image_url)
        # table = self._parse_table_from_ai_json(response)
        # 
        # # 품질 테스트 비활성화 - 항상 테이블 반환
        # self.log(f"[FAST_PATH] accepted rows={len(table)}")
        # return table
        # 
        # # 아래는 기존 품질 테스트 로직 (주석 처리)
        # # if self._is_fast_table_valid(table):
        # #     self.log(f"[FAST_PATH] accepted rows={len(table)}")
        # #     return table
        # # self.log("[FAST_PATH] rejected by quality gate")
        # # return None
        # ==========================================
    
    # ==================== 기존 단일 패스 방식 (주석 처리) ====================
    # def _try_single_pass_chemical_table_old(self, image_url):
    #     json_schema = json_handle(124)
    #     prompt = f"{PROMPT_CHEM_SINGLE_PASS_JSON}\n\nJSON 스키마 예시:\n{json_schema}"
    #     response = self._ai_call("with_chemical_fast", "single_pass_json", prompt, image_url)
    #     table = self._parse_table_from_ai_json(response)
    #     if self._is_fast_table_valid(table):
    #         self.log(f"[FAST_PATH] accepted rows={len(table)}")
    #         return table
    #     self.log("[FAST_PATH] rejected by quality gate")
    #     return None
    
    def process_image(self, image_path, rotation=None):
        """
        이미지 OCR 처리 메인 함수 (노트북 로직 그대로 구현)
        
        Args:
            image_path: 처리할 이미지 파일 경로
            rotation: 회전 설정 ('cw' 또는 None)
        
        Returns:
            dict: OCR 처리 결과
                {
                    "image_path": str,
                    "image_name": str,
                    "title": str,
                    "table": list[dict]
                }
        """
        self._reset_token_stats()
        try:
            self.progress(f"[INIT] 이미지 처리 시작: {os.path.basename(image_path)}")
            
            # 1. YOLO 서버 호출
            self.progress("──────────── [CROP] YOLO DETECTION START ────────────")
            yolo_result = call_yolo_server(image_path, rotation)
            
            # 2. Crop된 이미지들 추출
            chemical_crops = yolo_result.get('chemical_crops', [])
            table_crops = yolo_result.get('table_crops', [])
            original_image_base64 = yolo_result.get('original_image', '')
            
            # 원본 이미지 준비
            original_image = base64_to_pil(original_image_base64)
            image = self._get_cached_data_url(original_image)
            
            # Chemical/Table 추출 시도
            chemical_cut = 0
            table_cut = 0
            chemical_img_pil = None
            table_img_pil = None
            
            try:
                if len(chemical_crops) > 0:
                    chemical_img_pil = base64_to_pil(chemical_crops[0])
                    chemical_cut = 1
                if len(table_crops) > 0:
                    # 테이블이 2개 이상인 경우 원본 이미지 사용
                    if len(table_crops) >= 2:
                        self.progress(f"[CROP] 테이블 {len(table_crops)}개 감지됨 - 원본 이미지 사용")
                        table_cut = 0  # 원본 이미지를 사용하므로 table_cut을 0으로 설정
                    else:
                        table_img_pil = base64_to_pil(table_crops[0])
                        table_cut = 1
                if chemical_cut == 1 and table_cut == 1:
                    self.progress("[CROP] Chemical/Table 영역 자동 탐지 성공")
            except Exception as e:
                self.progress(f"[CROP] YOLO 탐지 실패, 개별 시도 중...: {e}")
                chemical_cut = 0
                table_cut = 0
                try:
                    if len(chemical_crops) > 0:
                        chemical_img_pil = base64_to_pil(chemical_crops[0])
                        self.progress("[CROP] Chemical 단독 추출 성공")
                        chemical_cut = 1
                except:
                    self.progress("[CROP] Chemical 추출 실패")
                try:
                    if len(table_crops) > 0:
                        table_img_pil = base64_to_pil(table_crops[0])
                        self.progress("[CROP] Table 단독 추출 성공")
                        table_cut = 1
                except:
                    self.progress("[CROP] Table 추출 실패")
            
            self.progress("────────────────────────────────────────────────────")
            
            # 3. Chemical 영역 처리 분기 (노트북 로직 그대로)
            if chemical_cut == 1:
                return self._process_with_chemical(
                    chemical_img_pil, table_img_pil, table_cut, image, image_path, chemical_crops
                )
            else:
                return self._process_without_chemical(
                    table_img_pil, table_cut, image, image_path
                )
        
        except Exception as e:
            self.log(f"[ERROR] OCR 처리 중 오류 발생: {str(e)}")
            self.log(traceback.format_exc())
            raise
        finally:
            self._log_token_summary(branch="process_image")
    
    def _process_with_chemical(self, chemical_img_pil, table_img_pil, table_cut, image, image_path, chemical_crops):
        """Chemical 영역이 있는 경우 처리 (노트북 로직 그대로)"""
        self.progress("[ANALYZE] Chemical 이미지 감지됨, 화학조성 분석 단계 진입")
        
        # image_path가 실제 경로인지 이름인지 확인
        if os.path.exists(image_path) if isinstance(image_path, str) else False:
            image_name = os.path.basename(image_path)
            result_image_path = image_path
        else:
            image_name = image_path  # 이미 이름인 경우
            result_image_path = image_path
        
        # 다중 Chemical 세그먼트 체크
        if len(chemical_crops) >= 2:
            self.progress(f"[ANALYZE] Chemical 세그먼트 수: {len(chemical_crops)}")
            full_img_pil = base64_to_pil(image.split(",")[1] if "," in image else image)
            full_img_pil_url = self._get_cached_data_url(full_img_pil)
            response_chem_pre = self._ai_call("with_chemical_multi", "chem_multi_extract", PROMPT_CHEM_MULTI, full_img_pil_url)

            merge_prompt = f"{response_chem_pre} 의 두 개의 markdown 테이블을 하나로 합쳐줘."
            response = self._ai_call("with_chemical_multi", "merge_two_markdown", merge_prompt)
            json_fm = json_handle(124)
            json_prompt = PROMPT_CHEM_TO_JSON.replace("{response}", response).replace("{json_fm}", json_fm)
            response_f = self._ai_call("with_chemical_multi", "markdown_to_json", json_prompt)
            
            # JSON 파싱
            try:
                json_text = parse_json_response(response_f)
                result_data = json.loads(json_text)
                table = result_data.get("table", [])
                
                # 소수점 형식 정규화 적용
                table = normalize_table_data(table)
                
                # 빈 테이블인 경우 로그 남기기
                if not table or (isinstance(table, list) and len(table) == 0):
                    self._log_empty_table_warning(
                        branch="with_chemical_multi",
                        stage="markdown_to_json",
                        raw_text=response_f,
                        table_data=result_data
                    )
                
                return {
                    "image_path": result_image_path,
                    "image_name": image_name,
                    "title": "Chemical Composition(%)",
                    "table": table
                }
            except Exception as e:
                self._log_parse_fallback(
                    branch="with_chemical_multi",
                    stage="markdown_to_json",
                    exc=e,
                    raw_text=response_f,
                )
                return {
                    "image_path": result_image_path,
                    "image_name": image_name,
                    "title": "Chemical Composition(%)",
                    "table": []
                }
        else:
            # 단일 Chemical 처리
            self.progress("[ANALYZE] 단일 Chemical 영역 처리 중...")
            
            #chemical_img_pil_url = self._get_cached_data_url(chemical_img_pil)
            # [C] _process_with_chemical()의 단일 chemical 분기(else:) 초반에 삽입
            # 기존:
            # chemical_img_pil_url = self._get_cached_data_url(chemical_img_pil)

            chemical_img_pil_url = self._get_cached_data_url(chemical_img_pil)
            table_img_pil_url = self._get_cached_data_url(table_img_pil) if table_cut == 1 else None

            # ========== 기존 코드 (주석 처리) ==========
            # # 1) fast path 먼저 시도
            # fast_image = table_img_pil_url or chemical_img_pil_url or image
            # fast_table = self._try_single_pass_chemical_table(fast_image)
            # ==========================================

            # 1) fast path 먼저 시도 - 항상 full image 사용
            # fast_image = table_img_pil_url or image  # 기존 코드
            fast_image = image  # 수정: 항상 full image 사용
            fast_table = self._try_single_pass_chemical_table(fast_image)

            if fast_table is not None:
                # fast path에서도 소수점 정규화 적용
                fast_table = normalize_table_data(fast_table)
                self.progress("[FAST_PATH] 단일 호출 추출 성공 -> 즉시 반환")
                return {
                    "image_path": result_image_path,
                    "image_name": image_name,
                    "title": "Chemical Composition(%)",
                    "table": fast_table,
                }

            # 2) 실패 시 기존 정밀 체인 유지 (현재 코드 그대로)
            self.progress("[FAST_PATH] 품질 게이트 미통과 -> 기존 정밀 체인 fallback")
            # ... 아래 기존 response_heat_check 부터 기존 로직 그대로 진행

            # Heat No 존재 여부 확인
            self.progress("[CHECK] chemical에 Heat No 존재 여부 검사 중...")
            response_heat_check = self._ai_call("with_chemical_single", "heat_exists_on_chemical", PROMPT_HEAT_EXIST_CHECK, chemical_img_pil_url)
            
            if response_heat_check == "No":
                response_chem_pre = self._ai_call("with_chemical_single", "chem_single_extract", PROMPT_CHEM_SINGLE, chemical_img_pil_url)
            else:
                response_chem_pre = self._ai_call("with_chemical_single", "chem_with_heat_extract", PROMPT_CHEM_WITH_HEAT, chemical_img_pil_url)
            
            self.progress("[ANALYZE] 화학조성 추출 완료")
            
            # Ladle/Product 존재 여부 확인
            self.progress("[CHECK] Ladle/Product 존재 여부 검사 중...")
            response_ladle_product_check = self._ai_call("with_chemical_single", "ladle_product_check", PROMPT_LADLE_PRODUCT_CHECK, chemical_img_pil_url)
            
            if response_ladle_product_check == "Yes":
                response_heat = self._ai_call("with_chemical_single", "heat_extract_from_full_image", PROMPT_HEAT_EXTRACT, image)
                prompt_merge = f"{response_chem_pre}\n{response_heat}\nLadle/Product 병합 수행, 반드시 아래에서 2줄만 출력."
                response = self._ai_call("with_chemical_single", "merge_ladle_product", prompt_merge)
            else:
                self.progress("[MERGE] Table 데이터와 2차 검토 중...")
                
                # 항상 full image 사용
                # if table_cut == 1:
                #     table_img_pil_url = self._get_cached_data_url(table_img_pil)
                #     prompt_chem_doublecheck = PROMPT_CHEM_DOUBLECHECK_TEMPLATE.format(
                #         response_chem_pre=response_chem_pre
                #     )
                #     response_chem = self._ai_call("with_chemical_single", "chem_doublecheck", prompt_chem_doublecheck, table_img_pil_url)
                # else:
                #     response_chem = response_chem_pre
                response_chem = response_chem_pre
                
                prompt_chem_plus = PROMPT_CHEM_PLUS_TEMPLATE.format(response_chem=response_chem)
                
                # 항상 full image 사용
                # if table_cut == 1:
                #     self.progress("[CHECK] Table 이미지 존재 → Heat No 존재 여부 확인")
                #     response_heat_check_table = self._ai_call("with_chemical_single", "heat_exists_on_table", PROMPT_HEAT_EXIST_CHECK, table_img_pil_url)
                self.progress("[CHECK] Full image 사용 → Heat No 존재 여부 확인")
                response_heat_check_table = self._ai_call("with_chemical_single", "heat_exists_on_table", PROMPT_HEAT_EXIST_CHECK, image)
                
                if response_heat_check_table == "No":
                    self.progress("[CHECK] Table 이미지에 Heat No 없음 → Heat No 별도 추출 후 병합")
                    response_heat = self._ai_call("with_chemical_single", "heat_extract_from_full_image_table", PROMPT_HEAT_EXTRACT, image)
                    prompt_heatPlusChem = PROMPT_HEAT_PLUS_CHEM_TEMPLATE.format(
                        response_heat=response_heat, response_chem=response_chem
                    )
                    response = self._ai_call("with_chemical_single", "merge_heat_plus_chem", prompt_heatPlusChem, image)
                else:
                    self.progress("[CHECK] Table 이미지에 Heat No 존재")
                    response_already_heatNo_check = self._ai_call(
                        "with_chemical_single",
                        "heat_exists_in_chem_text",
                        PROMPT_HEAT_EXIST_CHECK_IN_TEXT.format(markdown_text=response_chem),
                    )
                    # 항상 full image 사용
                    # if response_already_heatNo_check == "No":
                    #     self.progress("[MERGE] chemical에서 Heat No 미포함 → 병합 프롬프트 실행")
                    #     response = self._ai_call("with_chemical_single", "merge_chem_plus_table", prompt_chem_plus, table_img_pil_url)
                    # else:
                    #     self.progress("[MERGE] chemical에 Heat No 포함 → 2차 결과 사용")
                    #     response = response_chem
                    if response_already_heatNo_check == "No":
                        self.progress("[MERGE] chemical에서 Heat No 미포함 → 병합 프롬프트 실행")
                        response = self._ai_call("with_chemical_single", "merge_chem_plus_table", prompt_chem_plus, image)
                    else:
                        self.progress("[MERGE] chemical에 Heat No 포함 → 2차 결과 사용")
                        response = response_chem
            
            # JSON 변환
            json_fm = json_handle(124)
            json_prompt = PROMPT_CHEM_TO_JSON.replace("{response}", response).replace("{json_fm}", json_fm)
            response_f = self._ai_call("with_chemical_single", "markdown_to_json", json_prompt)
            
            # JSON 파싱
            try:
                json_text = parse_json_response(response_f)
                # result_data = self._extract_table_from_json_result(json_text)
                result_data = json.loads(json_text)
                table = result_data.get("table", [])
                
                # 소수점 형식 정규화 적용
                table = normalize_table_data(table)
                
                # 빈 테이블인 경우 로그 남기기
                if not table or (isinstance(table, list) and len(table) == 0):
                    self._log_empty_table_warning(
                        branch="with_chemical_single",
                        stage="markdown_to_json",
                        raw_text=response_f,
                        table_data=result_data
                    )
                
                return {
                    "image_path": result_image_path,
                    "image_name": image_name,
                    "title": "Chemical Composition(%)",
                    "table": table
                }
            except Exception as e:
                self._log_parse_fallback(
                    branch="with_chemical_single",
                    stage="markdown_to_json",
                    exc=e,
                    raw_text=response_f,
                )
                return {
                    "image_path": result_image_path,
                    "image_name": image_name,
                    "title": "Chemical Composition(%)",
                    "table": []
                }
    
    def _process_without_chemical(self, table_img_pil, table_cut, image, image_path):
        """Chemical 영역이 없는 경우 처리 - 2단계 분류 방식 사용"""
        self.progress("[ANALYZE] Chemical 이미지 없음 → 2단계 분류 방식으로 처리")
        
        # image_path가 실제 경로인지 이름인지 확인
        if os.path.exists(image_path) if isinstance(image_path, str) else False:
            image_name = os.path.basename(image_path)
            result_image_path = image_path
        else:
            image_name = image_path  # 이미 이름인 경우
            result_image_path = image_path
        
        # 1) fast path 먼저 시도 - 항상 full image 사용
        # fast_image = self._get_cached_data_url(table_img_pil) if table_cut == 1 else image  # 기존 코드
        fast_image = image  # 수정: 항상 full image 사용
        fast_table = self._try_single_pass_chemical_table(fast_image)

        if fast_table is not None:
            # fast path에서도 소수점 정규화 적용
            fast_table = normalize_table_data(fast_table)
            self.progress("[FAST_PATH] 단일 호출 추출 성공 -> 즉시 반환")
            return {
                "image_path": result_image_path,
                "image_name": image_name,
                "title": "General Information",
                "table": fast_table,
            }

        # 2) 실패 시 기존 방식으로 fallback
        self.progress("[FAST_PATH] 품질 게이트 미통과 -> 기존 방식 fallback")
        
        # 항상 full image 사용
        # if table_cut == 1:
        #     table_img_pil_url = self._get_cached_data_url(table_img_pil)
        #     response = self._ai_call("without_chemical", "all_extract_from_table", PROMPT_ALL_EXTRACT, table_img_pil_url)
        # else:
        #     response = self._ai_call("without_chemical", "all_extract_from_full_image", PROMPT_ALL_EXTRACT, image)
        response = self._ai_call("without_chemical", "all_extract_from_full_image", PROMPT_ALL_EXTRACT, image)
        
        # JSON 변환
        json_fm = json_handle(124)
        json_prompt = PROMPT_CHEM_TO_JSON.replace("{response}", response).replace("{json_fm}", json_fm)
        response_f = self._ai_call("without_chemical", "markdown_to_json", json_prompt)
        
        # JSON 파싱
        try:
            json_text = parse_json_response(response_f)
            result_data = json.loads(json_text)
            table = result_data.get("table", [])
            
            # 소수점 형식 정규화 적용
            table = normalize_table_data(table)
            
            # 빈 테이블인 경우 로그 남기기
            if not table or (isinstance(table, list) and len(table) == 0):
                self._log_empty_table_warning(
                    branch="without_chemical",
                    stage="markdown_to_json",
                    raw_text=response_f,
                    table_data=result_data
                )
            
            return {
                "image_path": result_image_path,
                "image_name": image_name,
                "title": "General Information",
                "table": table
            }
        except Exception as e:
            self._log_parse_fallback(
                branch="without_chemical",
                stage="markdown_to_json",
                exc=e,
                raw_text=response_f,
            )
            return {
                "image_path": result_image_path,
                "image_name": image_name,
                "title": "General Information",
                "table": []
            }
    
    def process_crops(self, chemical_crops, table_crops, original_image_base64, image_name="unknown"):
        """
        Crop된 이미지들을 직접 받아서 OCR 처리
        
        Args:
            chemical_crops: base64 인코딩된 chemical crop 이미지 리스트
            table_crops: base64 인코딩된 table crop 이미지 리스트
            original_image_base64: base64 인코딩된 원본 이미지
            image_name: 이미지 이름 (선택사항)
        
        Returns:
            dict: OCR 처리 결과
                {
                    "image_name": str,
                    "title": str,
                    "table": list[dict]
                }
        """
        self._reset_token_stats()
        try:
            self.progress(f"[INIT] Crop 이미지 처리 시작: {image_name}")
            self._log_ctx(
                branch="process_crops",
                stage="input",
                prompt=f"chemical_crops={len(chemical_crops)}, table_crops={len(table_crops)}",
                image_url=original_image_base64,
            )
            
            # 원본 이미지 준비
            original_image = base64_to_pil(original_image_base64)
            image = self._get_cached_data_url(original_image)
            self._log_ctx(branch="process_crops", stage="after_image_prepare", image_url=image)
            
            # Chemical/Table 추출 시도
            chemical_cut = 0
            table_cut = 0
            chemical_img_pil = None
            table_img_pil = None
            
            try:
                if len(chemical_crops) > 0:
                    chemical_img_pil = base64_to_pil(chemical_crops[0])
                    chemical_cut = 1
                if len(table_crops) > 0:
                    # 테이블이 2개 이상인 경우 원본 이미지 사용
                    if len(table_crops) >= 2:
                        self.progress(f"[CROP] 테이블 {len(table_crops)}개 감지됨 - 원본 이미지 사용")
                        table_cut = 0  # 원본 이미지를 사용하므로 table_cut을 0으로 설정
                    else:
                        table_img_pil = base64_to_pil(table_crops[0])
                        table_cut = 1
                if chemical_cut == 1 and table_cut == 1:
                    self.progress("[CROP] Chemical/Table 영역 자동 탐지 성공")
            except Exception as e:
                self.progress(f"[CROP] Crop 이미지 처리 실패, 개별 시도 중...: {e}")
                chemical_cut = 0
                table_cut = 0
                try:
                    if len(chemical_crops) > 0:
                        chemical_img_pil = base64_to_pil(chemical_crops[0])
                        self.progress("[CROP] Chemical 단독 추출 성공")
                        chemical_cut = 1
                except:
                    self.progress("[CROP] Chemical 추출 실패")
                try:
                    if len(table_crops) > 0:
                        table_img_pil = base64_to_pil(table_crops[0])
                        self.progress("[CROP] Table 단독 추출 성공")
                        table_cut = 1
                except:
                    self.progress("[CROP] Table 추출 실패")
            
            self.progress("────────────────────────────────────────────────────")
            
            # Chemical 영역 처리 분기
            if chemical_cut == 1:
                result = self._process_with_chemical(
                    chemical_img_pil, table_img_pil, table_cut, image, image_name, chemical_crops
                )
                # image_path 대신 image_name 사용
                result["image_name"] = image_name
                if "image_path" in result:
                    del result["image_path"]
                return result
            else:
                result = self._process_without_chemical(
                    table_img_pil, table_cut, image, image_name
                )
                # image_path 대신 image_name 사용
                result["image_name"] = image_name
                if "image_path" in result:
                    del result["image_path"]
                return result
        
        except Exception as e:
            self.log(f"[ERROR] Crop 이미지 OCR 처리 중 오류 발생: {str(e)}")
            self.log(traceback.format_exc())
            raise
        finally:
            self._log_token_summary(branch="process_crops")
