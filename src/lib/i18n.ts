import { it } from "@/messages/it";
import { zh } from "@/messages/zh";
export type Locale = "it" | "zh";
export function localeOf(value: unknown): Locale {
  return value === "zh" ? "zh" : "it";
}
export const messages = { it, zh };
const errors: Record<string, string> = {
  "Clienti non disponibili. Aggiorna la pagina e riprova.":
    "部分客户已不可用，请刷新页面后重试。",
  "Telefoni duplicati.": "电话号码不能重复。",
  "Massimo tre telefoni per cliente.": "每位客户最多三个电话号码。",
  "Telefono già associato a un altro cliente.": "该电话号码已属于另一位客户。",
  "Cliente eliminato: usa un altro telefono.":
    "该号码属于已删除的客户，请先核对客户记录。",
  "Prezzi diversi per lo stesso intervento: distingui la specifica del ricambio.":
    "同一维修项目报价不同，请在项目名称中区分配件规格。",
  "Controlla i campi obbligatori e gli importi.": "请检查必填项和金额。",
  "Lo sconto supera il prezzo.": "优惠金额不能超过原价。",
  "Acconto consentito solo alla creazione della scheda.":
    "预付款仅可在创建维修单时登记。",
  "Indica il problema segnalato.": "请选择或填写报修故障。",
  "L'acconto supera il totale.": "接单收款金额超过应收总额。",
  "Il nuovo totale è inferiore agli incassi già registrati.":
    "新的应收总额低于已收款，请先核对收款。",
  "L'importo supera il saldo da pagare.": "收款金额超过待收余额。",
  "L'importo deve essere maggiore di zero.": "收款金额必须大于零。",
  "La scheda è chiusa.": "维修单已关闭。",
  "La scheda è annullata.": "维修单已取消。",
  "La riparazione non è pronta per la consegna.": "维修尚未进入待取机状态。",
  "I ricambi sono già stati contabilizzati.": "维修配件库存已经扣减。",
  "Ricambi non registrati: completa prima il controllo di magazzino.":
    "还有未登记扣减的维修配件，请先完成配件库存核对。",
  "Per modificare i ricambi richiesti, riaprire prima la riparazione.":
    "要修改所需维修配件，请先重新打开维修流程。",
  "Non puoi cambiare il ricambio di un'opzione già usata in una scheda. Crea una nuova opzione.":
    "已被维修单引用的报价方案不能更换配件；请新建报价方案。",
  "Verifica i ricambi non contabilizzati prima di modificare il preventivo.":
    "报价修改前，请先核对尚未登记的维修配件。",
  "L'incassato supera il nuovo totale: registra prima il rimborso.":
    "已收金额超过删除商品后的新总额，请先登记退款。",
  "Il movimento di magazzino è già registrato.": "该商品的库存变动已经记录。",
  "Prodotto non disponibile.": "商品不可用。",
  "Scorte insufficienti o prodotto non disponibile.": "商品库存不足或不可用。",
  "Registra prima la conferma del preventivo.": "请先登记客户报价确认。",
  "Indica chi ritira il dispositivo.": "请填写取机人姓名。",
  "Cambio di stato non consentito.": "不允许变更为该状态。",
  "Saldo aperto: è necessaria la conferma esplicita del titolare.":
    "存在未收余额，请明确确认后交付。",
  "Il dispositivo non appartiene al cliente selezionato.":
    "设备不属于当前客户。",
  "Richiesta di pagamento già utilizzata.": "该付款请求已使用，请刷新后核对。",
  "Sono presenti incassi: gestire il rimborso prima dell'annullamento. I rimborsi non sono inclusi nel MVP.":
    "已有收款，取消前需处理退款；当前版本不支持退款。",
  "Importo non valido (massimo 2 decimali).": "金额无效，最多两位小数。",
  "Importo non valido.": "金额无效。",
  "Questa categoria è già utilizzata da prodotti e non può essere eliminata.":
    "该分类已有商品使用，无法删除。",
  "Il marchio è associato a dati aziendali e non può essere eliminato.":
    "该品牌已有业务数据关联，无法删除。",
  "Il modello è associato a dati aziendali e non può essere eliminato.":
    "该型号已有业务数据关联，无法删除。",
  "Numero di telefono non valido.": "电话号码无效。",
  "Record già presente. Controlla i dati e riprova.":
    "记录已存在，请核对后重试。",
  "Operazione non riuscita. Aggiorna la pagina e riprova.":
    "操作失败，请刷新后重试。",
  "La consegna non può precedere oggi.": "交付日期不能早于今天。",
  "Connessione non disponibile. Riprova.": "连接失败，请重试。",
  "Riprovare l'operazione.": "请重试。",
  "Sessione non valida. Accedi di nuovo.": "本地操作记录不可用，请刷新后重试。",
};
export function translateError(message: string, locale: Locale) {
  return locale === "it"
    ? message
    : (errors[message] ?? "操作失败，请检查填写内容后重试。");
}
