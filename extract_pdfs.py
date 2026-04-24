from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
import sys

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT_DIR = ROOT
DEFAULT_OUTPUT = ROOT / "data" / "titulos.json"

CLIENT_RE = re.compile(
    r"^Cliente:(?P<codigo>\d+)\s*-\s*(?P<nome>.+?)\s+Ativo:(?P<ativo>[SN])\s+Cond\.Pagto\.:(?P<condicao>.+)$"
)
CLIENT_OPEN_RE = re.compile(
    r"^Cliente:\s*-(?P<codigo>\d+)\s+(?P<nome>.+?)\s+Ativo:(?P<ativo>[SN])\s+CPG:(?P<condicao>.+?)\s+Desc\.:.+$"
)
TITLE_RE = re.compile(
    r"^(?P<operacao>\S+)\s+(?P<tipo>\S+)\s+(?P<parcela>\d+)\s+(?P<serie>\d+)\s+"
    r"(?P<data_emissao>\d{2}/\d{2}/\d{4})\s+(?P<valor>[\d\.,]+)\s+(?P<resto>.+)$"
)
OPEN_TITLE_RE = re.compile(
    r"^(?P<operacao>\S+)\s+(?P<titulo>\d+)\s+(?P<tipo>\S+)\s+(?P<parcela>\d+)\s+(?P<serie>\d+)\s+"
    r"(?P<data_emissao>\d{2}/\d{2}/\d{2})\s+(?P<valor>[\d\.,]+)\s+(?P<data_vencimento>\d{2}/\d{2}/\d{2})\s+(?P<resto>\S+)$"
)
DATE_RE = re.compile(r"\d{2}/\d{2}/\d{4}")
DATE_SHORT_RE = re.compile(r"\d{2}/\d{2}/\d{2}")
TOTAL_RE = re.compile(r"^Total:\s+(?P<valor>[\d\.,]+)$")
TOTAL_OPEN_RE = re.compile(r"^(?P<valor>[\d\.,]+)Total do Cliente:$")
BASE_DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
EMISSION_RE = re.compile(r"^Emiss.*?:\s*(?P<data>\d{2}/\d{2}/\d{4})")


def br_number_to_float(value: str) -> float:
    return float(value.replace(".", "").replace(",", "."))


def format_currency(value: float) -> str:
    return f"{value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def parse_rest(rest: str) -> dict[str, str]:
    parts = rest.split()
    due_date = DATE_RE.search(rest)
    due = due_date.group(0) if due_date else ""

    trailing = parts[-3:] if len(parts) >= 3 else parts
    return {
        "data_vencimento": due,
        "indicador": trailing[0] if len(trailing) >= 1 else "",
        "titulo": trailing[1] if len(trailing) >= 2 else "",
        "numero_boleto": trailing[2] if len(trailing) >= 3 else "",
        "linha_original": rest,
    }


def normalize_date(value: str) -> str:
    if len(value) == 8:
        return datetime.strptime(value, "%d/%m/%y").strftime("%d/%m/%Y")
    return value


def parse_open_rest(rest: str) -> dict[str, str]:
    match = re.match(r"(?P<numero>\d+)?(?P<indicador>[SN])?(?P<saldo>-?\d+)?", rest)
    if not match:
        return {
            "indicador": "",
            "titulo": "",
            "numero_boleto": "",
            "linha_original": rest,
        }
    return {
        "indicador": f"{match.group('indicador') or ''}{match.group('saldo') or ''}",
        "numero_boleto": match.group("numero") or "",
        "linha_original": rest,
    }


def detect_report_type(pdf_path: Path) -> tuple[str, str]:
    stem = pdf_path.stem
    if " - " not in stem:
        raise ValueError(f"Nome de arquivo fora do padrao: {pdf_path.name}")

    prefix, vendedor = stem.split(" - ", 1)
    normalized_prefix = prefix.strip().lower()

    if normalized_prefix == "titulos":
        return vendedor, "aberto"
    if "vencidos" in normalized_prefix:
        return vendedor, "vencidos"
    if "vencer" in normalized_prefix:
        return vendedor, "a_vencer"

    raise ValueError(f"Tipo de relatorio nao reconhecido: {pdf_path.name}")


def parse_pdf(pdf_path: Path) -> dict:
    vendedor, categoria = detect_report_type(pdf_path)
    with pdf_path.open("rb") as stream:
        reader = PdfReader(stream)
        clients = []
        current_client = None
        data_base = ""

        for page in reader.pages:
            text = page.extract_text() or ""
            for raw_line in text.splitlines():
                line = " ".join(raw_line.split()).strip()
                if not line:
                    continue

                emission_match = EMISSION_RE.match(line)
                if emission_match:
                    data_base = emission_match.group("data")
                    continue

                if BASE_DATE_RE.match(line):
                    data_base = line
                    continue

                client_match = CLIENT_RE.match(line)
                if client_match:
                    if current_client:
                        clients.append(current_client)
                    current_client = {
                        "codigo": int(client_match.group("codigo")),
                        "nome": client_match.group("nome").strip(),
                        "ativo": client_match.group("ativo") == "S",
                        "condicao_pagamento": client_match.group("condicao").strip(),
                        "titulos": [],
                        "total": 0.0,
                    }
                    continue

                client_open_match = CLIENT_OPEN_RE.match(line)
                if client_open_match:
                    if current_client:
                        clients.append(current_client)
                    current_client = {
                        "codigo": int(client_open_match.group("codigo")),
                        "nome": client_open_match.group("nome").strip(),
                        "ativo": client_open_match.group("ativo") == "S",
                        "condicao_pagamento": client_open_match.group("condicao").strip(),
                        "titulos": [],
                        "total": 0.0,
                    }
                    continue

                total_match = TOTAL_RE.match(line)
                if total_match and current_client:
                    current_client["total"] = br_number_to_float(total_match.group("valor"))
                    clients.append(current_client)
                    current_client = None
                    continue

                total_open_match = TOTAL_OPEN_RE.match(line)
                if total_open_match and current_client:
                    current_client["total"] = br_number_to_float(total_open_match.group("valor"))
                    clients.append(current_client)
                    current_client = None
                    continue

                title_match = TITLE_RE.match(line)
                if title_match and current_client:
                    parsed_rest = parse_rest(title_match.group("resto"))
                    current_client["titulos"].append(
                        {
                            "operacao": title_match.group("operacao"),
                            "tipo": title_match.group("tipo"),
                            "parcela": int(title_match.group("parcela")),
                            "serie": title_match.group("serie"),
                            "data_emissao": title_match.group("data_emissao"),
                            "valor": br_number_to_float(title_match.group("valor")),
                            **parsed_rest,
                            "raw": line,
                        }
                    )
                    continue

                open_title_match = OPEN_TITLE_RE.match(line)
                if open_title_match and current_client:
                    parsed_rest = parse_open_rest(open_title_match.group("resto"))
                    current_client["titulos"].append(
                        {
                            "operacao": open_title_match.group("operacao"),
                            "tipo": open_title_match.group("tipo"),
                            "parcela": int(open_title_match.group("parcela")),
                            "serie": open_title_match.group("serie"),
                            "data_emissao": normalize_date(open_title_match.group("data_emissao")),
                            "valor": br_number_to_float(open_title_match.group("valor")),
                            "data_vencimento": normalize_date(open_title_match.group("data_vencimento")),
                            "titulo": open_title_match.group("titulo"),
                            **parsed_rest,
                            "raw": line,
                        }
                    )

        if current_client:
            clients.append(current_client)

        for client in clients:
            for title in client["titulos"]:
                title["dias_diferenca"] = diff_days(title["data_vencimento"], data_base)
                if categoria == "aberto":
                    title["categoria"] = "vencidos" if (title["dias_diferenca"] or 0) >= 0 else "a_vencer"

    return {
        "arquivo": pdf_path.name,
        "vendedor": vendedor,
        "categoria": categoria,
        "data_base": data_base,
        "clientes": clients,
    }


def diff_days(due_date: str, base_date: str) -> int | None:
    if not due_date or not base_date:
        return None
    due = datetime.strptime(due_date, "%d/%m/%Y")
    base = datetime.strptime(base_date, "%d/%m/%Y")
    return (base - due).days


def build_summary(reports: list[dict]) -> dict:
    by_vendor: dict[str, dict] = defaultdict(
        lambda: {
            "vendedor": "",
            "data_base": "",
            "clientes": [],
            "resumo": {
                "clientes": 0,
                "titulos": 0,
                "valor_total": 0.0,
                "vencidos": 0.0,
                "a_vencer": 0.0,
            },
        }
    )

    grouped_clients: dict[tuple[str, int], dict] = {}

    for report in reports:
        vendor_bucket = by_vendor[report["vendedor"]]
        vendor_bucket["vendedor"] = report["vendedor"]
        vendor_bucket["data_base"] = report["data_base"]

        for client in report["clientes"]:
            key = (report["vendedor"], client["codigo"])
            if key not in grouped_clients:
                grouped_clients[key] = {
                    "codigo": client["codigo"],
                    "nome": client["nome"],
                    "ativo": client["ativo"],
                    "condicao_pagamento": client["condicao_pagamento"],
                    "titulos": [],
                    "total_vencidos": 0.0,
                    "total_a_vencer": 0.0,
                    "total_geral": 0.0,
                    "qtde_titulos": 0,
                    "maior_atraso_dias": 0,
                    "status_prioridade": "normal",
                }
                vendor_bucket["clientes"].append(grouped_clients[key])

            entry = grouped_clients[key]
            if report["categoria"] == "aberto":
                entry["titulos"].extend(client["titulos"])
                total_vencidos = round(sum(title["valor"] for title in client["titulos"] if title["categoria"] == "vencidos"), 2)
                total_a_vencer = round(sum(title["valor"] for title in client["titulos"] if title["categoria"] == "a_vencer"), 2)
                entry["total_vencidos"] += total_vencidos
                entry["total_a_vencer"] += total_a_vencer
                vendor_bucket["resumo"]["vencidos"] += total_vencidos
                vendor_bucket["resumo"]["a_vencer"] += total_a_vencer
            else:
                entry["titulos"].extend(
                    {
                        **title,
                        "categoria": report["categoria"],
                    }
                    for title in client["titulos"]
                )

                if report["categoria"] == "vencidos":
                    entry["total_vencidos"] += client["total"]
                    vendor_bucket["resumo"]["vencidos"] += client["total"]
                else:
                    entry["total_a_vencer"] += client["total"]
                    vendor_bucket["resumo"]["a_vencer"] += client["total"]

            entry["total_geral"] += client["total"]
            entry["qtde_titulos"] = len(entry["titulos"])
            vendor_bucket["resumo"]["valor_total"] += client["total"]
            vendor_bucket["resumo"]["titulos"] += len(client["titulos"])

            atrasos = [t["dias_diferenca"] for t in entry["titulos"] if t["categoria"] == "vencidos" and t["dias_diferenca"] is not None]
            entry["maior_atraso_dias"] = max(atrasos) if atrasos else 0
            if entry["total_vencidos"] >= 5000 or entry["maior_atraso_dias"] >= 60:
                entry["status_prioridade"] = "alta"
            elif entry["total_vencidos"] > 0:
                entry["status_prioridade"] = "media"

        vendor_bucket["resumo"]["clientes"] = len(vendor_bucket["clientes"])

    for vendor in by_vendor.values():
        vendor["clientes"].sort(key=lambda client: (-client["total_vencidos"], client["nome"]))
        for client in vendor["clientes"]:
            client["titulos"].sort(
                key=lambda item: (
                    0 if item["categoria"] == "vencidos" else 1,
                    -item["dias_diferenca"] if item["dias_diferenca"] is not None else 0,
                    item["data_vencimento"],
                )
            )

    resumo_geral = {
        "data_atualizacao": datetime.now().isoformat(timespec="seconds"),
        "moeda": "BRL",
        "valor_total": round(sum(v["resumo"]["valor_total"] for v in by_vendor.values()), 2),
        "vendedores": sorted(by_vendor.keys()),
        "clientes": sum(v["resumo"]["clientes"] for v in by_vendor.values()),
        "titulos": sum(v["resumo"]["titulos"] for v in by_vendor.values()),
    }

    return {
        "meta": resumo_geral,
        "vendedores": list(sorted(by_vendor.values(), key=lambda item: item["vendedor"])),
        "relatorios": reports,
        "helpers": {
            "currency_example": format_currency(1234.56),
        },
    }


def main() -> None:
    input_dir = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_INPUT_DIR
    output_path = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else DEFAULT_OUTPUT

    pdfs = sorted(input_dir.glob("*.pdf"))
    reports = [parse_pdf(pdf) for pdf in pdfs]
    payload = build_summary(reports)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Arquivo gerado em: {output_path}")


if __name__ == "__main__":
    main()
