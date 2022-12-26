import {
  ContractPromise,
  storage,
  logging,
  Context,
  u128,
  PersistentMap,
} from "near-sdk-as";

export const TGAS: u64 = 1000000000000;
export const XCC_SUCCESS = 1;
export const NO_DEPOSIT: u128 = u128.Zero;

export const ICODatas = new PersistentMap<u32, ICOData>("ICOData"); //icotype -> icodata
export const isIcoMember = new PersistentMap<string, boolean>("isIcoMember"); //address+icotype -> boolean
export const icoMembers = new PersistentMap<u32, string[]>("icoMembers"); //icotype -> addresses[]

export const whitelist = new PersistentMap<u32, string[]>("whitelist");

enum IcoStates {
  active = 0, //(0)
  nonActive = 1, //beneficiary kaynaklı claim ve buytoken fonksyionları çalışmaz yani tüm işlemler durdurulmuş olur(default (1))
  done = 2, //leftover can be transferred to the storage "totalleftover" variable (2)
}

@nearBindgen
export class ICOData {
  ICOname: string;
  ICOsupply: u32;
  ICOusdtRaised: u32;
  ICOtokenAllocated: u32;
  ICOtokenSold: u32;
  ICOstate: IcoStates;
  ICOnumberOfCliff: u32;
  ICOnumberOfVesting: u32;
  ICOunlockRate: u32;
  ICOstartDate: u64;
  TokenAbsoluteUsdtPrice: u32;
  IsFree: boolean;
  isOnlyWhitelist: boolean;

  constructor() {
    this.ICOusdtRaised = 0;
    this.ICOtokenAllocated = 0;
    this.ICOtokenSold = 0;
    this.ICOstate = IcoStates.nonActive;
  }
}

export function initFunc(vestingAddress: string): void {
  logging.log("initfuncttt");
  _onlyOwner("init");

  const initialized: bool = storage.getPrimitive<bool>("init", false);
  assert(!initialized, "ERROR at initFunc: Already initialized");
  storage.set<bool>("init", true);

  storage.set("vesting-address", vestingAddress);
}

export function setVestingAddress(_address: string): void {
  _onlyOwner("setVestingAddress");
  storage.set("vesting-address", _address);
}

export function changeIcoState(_icoType: u32, _icoState: u32): void {
  _onlyOwner("changeIcoState");
  var icoData = ICODatas.getSome(_icoType);
  icoData.ICOstate = _icoState;

  //changes state of the sale in vesting by using promise
  changeIcoStateInVestingCall(_icoType, _icoState);

  if (icoData.ICOstate == IcoStates.done) {
    var saleLeftover = icoData.ICOsupply - icoData.ICOtokenAllocated;

    icoData.ICOsupply -= saleLeftover;

    var totalLeftover =
      storage.getPrimitive<u32>("totalLeftover", 0) + saleLeftover;

    storage.set<u32>("totalLeftover", totalLeftover);
  }
  ICODatas.set(_icoType, icoData);
}

export function increaseIcoSupplyWithLeftover(
  _icoType: u32,
  _amount: u32
): void {
  _onlyOwner("increaseIcoSupplyWithLeftover");

  var ICOData = ICODatas.getSome(_icoType);
  var totalLeftover = storage.getPrimitive<u32>("totalLeftover", 0);

  assert(
    ICOData.ICOstate != 2,
    "ERROR at increaseIcoSupplyWithLeftover: Target ICO is already done."
  );

  assert(
    totalLeftover >= _amount,
    "ERROR at increaseIcoSupplyWithLeftover: Not enough leftover."
  );

  ICOData.ICOsupply += _amount;
  ICODatas.set(_icoType, ICOData);

  totalLeftover -= _amount;
  storage.set<u32>("totalLeftover", totalLeftover);
}

export function createICO(
  _name: string,
  _supply: u32,
  _cliffMonths: u32,
  _vestingMonths: u32,
  _unlockRate: u32,
  _startDate: u64, // second type timestamp
  _tokenAbsoluteUsdtPrice: u32, //0 if free
  _isFree: boolean, //1 if free, 0 if not-free
  _isOnlyWhitelist: boolean //if ico type accepting only whitelisted beneficiary => 1, else => 0
): void {
  _onlyOwner("createICO");

  var currentTime = _getTimeAsSeconds();
  logging.log(currentTime);
  assert(
    _startDate >= currentTime,
    "ERROR at createICO: Start date must be greater than now."
  );

  if (_isFree == false) {
    assert(
      _tokenAbsoluteUsdtPrice > 0,
      "ERROR at createICO: Token price should be bigger than zero."
    );
  } else if (_isFree == true) {
    assert(
      _tokenAbsoluteUsdtPrice == 0,
      "ERROR at createICO: Token price should be zero for family sales."
    );
  } else {
    logging.log("else");
    return;
  }

  /*require(
    totalAllocation + _supply <= token.balanceOf(msg.sender),
    "ERROR at createICO: Cannot create sale round because not sufficient tokens."
);
*/
  _increaseTotalAllocation(_supply);

  var newICOData = new ICOData();
  newICOData.ICOname = _name;
  newICOData.ICOsupply = _supply;
  newICOData.ICOnumberOfCliff = _cliffMonths;
  newICOData.ICOnumberOfVesting = _vestingMonths;
  newICOData.ICOunlockRate = _unlockRate;
  newICOData.ICOstartDate = _startDate;
  newICOData.TokenAbsoluteUsdtPrice = _tokenAbsoluteUsdtPrice;
  newICOData.IsFree = _isFree;
  newICOData.isOnlyWhitelist = _isOnlyWhitelist;

  if (_isOnlyWhitelist) {
    whitelist.set(_getICOindex(), []);
  }

  ICODatas.set(_getICOindex(), newICOData);
  icoMembers.set(_getICOindex(), []);
  _increaseICOindex();
}

export function buyTokens(_icoType: u32, _usdtAmount: u32): void {
  var icoData = ICODatas.getSome(_icoType);

  assert(
    icoData.IsFree == false,
    "ERROR at buyTokens: This token distribution is exclusive to the team only."
  );
  assert(
    icoData.ICOstate == IcoStates.active,
    "ERROR at buytokens: Sale round is currently stopped."
  );
  assert(
    icoData.ICOstartDate >= _getTimeAsSeconds(),
    "ERROR at buyTokens: ICO date expired."
  );
  var beneficiaryAddress = Context.sender;
  var vestingKeyString = beneficiaryAddress.concat(_icoType.toString());

  assert(
    isWhitelisted(beneficiaryAddress, _icoType),
    "ERROR at buyTokens: This token distribution is exclusive to the whitelisted users only."
  );

  var tokenAmount = _getTokenAmount(
    _usdtAmount,
    icoData.TokenAbsoluteUsdtPrice
  );

  _preValidatePurchase(beneficiaryAddress, tokenAmount, _usdtAmount, _icoType);

  if (!isIcoMember.contains(vestingKeyString)) {
    createVestingScheduleCall(
      beneficiaryAddress,
      _icoType,
      tokenAmount,
      icoData.ICOnumberOfCliff,
      icoData.ICOnumberOfVesting,
      icoData.ICOunlockRate,
      true,
      _usdtAmount,
      icoData.ICOstartDate,
      icoData.TokenAbsoluteUsdtPrice
    );
    isIcoMember.set(vestingKeyString, true);

    //icoMembers.getSome(_icoType).push(beneficiaryAddress);

    var tempMemberArray = icoMembers.getSome(_icoType);
    tempMemberArray.push(beneficiaryAddress);
    icoMembers.set(_icoType, tempMemberArray);
  } else {
    var totalVestingAllocation =
      tokenAmount - (icoData.ICOunlockRate * tokenAmount) / 100;
    updateVestingScheduleCall(
      vestingKeyString,
      tokenAmount,
      totalVestingAllocation,
      _usdtAmount
    );
  }

  _updatePurchasingState(_usdtAmount, tokenAmount, _icoType);
  _forwardFunds(_usdtAmount);
}

//only owner can add team member to vesting schedule
export function addingTeamMemberToVesting(
  _beneficiary: string,
  _icoType: u32,
  _tokenAmount: u32
): void {
  logging.log(Context.usedGas);
  logging.log(Context.prepaidGas);

  _onlyOwner("addingTeamMemberToVesting");

  var icoData = ICODatas.getSome(_icoType);

  assert(
    icoData.IsFree == true,
    "ERROR at addingTeamParticipant: Please give correct sale type."
  );

  var vestingKeyString = _beneficiary.concat(_icoType.toString());

  _preValidatePurchase(_beneficiary, _tokenAmount, 0, _icoType);

  createVestingScheduleCall(
    _beneficiary,
    _icoType,
    _tokenAmount,
    icoData.ICOnumberOfCliff,
    icoData.ICOnumberOfVesting,
    icoData.ICOunlockRate,
    true,
    0,
    icoData.ICOstartDate,
    0
  );
  isIcoMember.set(vestingKeyString, true);

  //icoMembers.getSome(_icoType).push(_beneficiary);

  var tempMemberArray = icoMembers.getSome(_icoType);
  tempMemberArray.push(_beneficiary);
  icoMembers.set(_icoType, tempMemberArray);

  _updatePurchasingState(0, _tokenAmount, _icoType);
}

/*export function changeAbsoluteTokenUsdtPrice(
  _newTokenPrice: u32,
  _icoType: u32
): void {
  _onlyOwner("changeAbsoluteTokenUsdtPrice");
  var icoData = ICODatas.getSome(_icoType);

  assert(
    _getTimeAsSeconds() < icoData.ICOstartDate,
    "ERROR at changeAbsoluteTokenUsdtPrice: ICO has already started."
  );

  icoData.TokenAbsoluteUsdtPrice = _newTokenPrice;
  ICODatas.set(_icoType, icoData);
}*/

export function addToWhitelist(_beneficiaries: string[], _icoType: u32): void {
  _onlyOwner("addToWhitelist");
  var icoData = ICODatas.getSome(_icoType);
  assert(
    icoData.isOnlyWhitelist,
    "ERROR at addToWhitelist: This sale round is not using whitelist concept."
  );
  for (var x = 0; x < _beneficiaries.length; x++) {
    addAddressToWhitelist(_beneficiaries[x], _icoType);
  }
}

/**
 * @CALLED_FUNCS
 */
//////////////////////////////////////////////////////////////////////////////////////////
//in vesting contract, after token claims
export function increaseICOtokenSold(_amount: u32, _icoType: u32): void {
  _onlyVestingContract("increaseICOtokenSold");
  var ICOData = ICODatas.getSome(_icoType);
  ICOData.ICOtokenSold += _amount;
  ICODatas.set(_icoType, ICOData);
}

/**
 * @VIEW
 */
//////////////////////////////////////////////////////////////////////////////////////////
export function getIcoMembers(_icoType: u32): Array<string> {
  assert(
    icoMembers.contains(_icoType),
    "ERROR at getIcoMembers: There is no sale round with this type."
  );
  return icoMembers.getSome(_icoType);
}
export function getWhitelistOfRound(_icoType: u32): Array<string> {
  assert(
    ICODatas.contains(_icoType),
    "ERROR at getWhitelistOfRound: There is no sale round with this index."
  );
  assert(
    whitelist.contains(_icoType),
    "ERROR at getWhitelistOfRound: Given sale round is not using whitelist concept."
  );
  return whitelist.getSome(_icoType);
}

export function getICODetails(_ICOindex: u32): void {
  assert(
    ICODatas.contains(_ICOindex),
    "ERROR at getICODetails: There is no sale round with this index."
  );

  var ICOData = ICODatas.getSome(_ICOindex);

  logging.log(ICOData.ICOname);
  logging.log(ICOData.ICOsupply.toString());
  logging.log(ICOData.ICOusdtRaised.toString());
  logging.log(ICOData.ICOtokenAllocated.toString());
  logging.log(ICOData.ICOtokenSold.toString());
  logging.log(ICOData.ICOstate.toString());
  logging.log(ICOData.ICOnumberOfCliff.toString());
  logging.log(ICOData.ICOnumberOfVesting.toString());
  logging.log(ICOData.ICOunlockRate.toString());
  logging.log(ICOData.ICOstartDate.toString());
  logging.log(ICOData.TokenAbsoluteUsdtPrice.toString());
  logging.log(ICOData.IsFree.toString());
  logging.log(ICOData.isOnlyWhitelist.toString());
}
export function getTotalAllocation(): u32 {
  return storage.getPrimitive<u32>("totalAllocation", 0);
}
export function getLeftover(): u32 {
  _onlyOwner("getLeftover");
  return storage.getPrimitive<u32>("totalLeftover", 0);
}
//////////////////////////////////////////////////////////////////////////////////////////

/**
 * @UTILS
 */
//////////////////////////////////////////////////////////////////////////////////////////
function _increaseTotalAllocation(addToAllocation: u32): void {
  const totalAllocationValue =
    storage.getPrimitive<u32>("totalAllocation", 0) + addToAllocation;
  storage.set<u32>("totalAllocation", totalAllocationValue);
}

function _increaseICOindex(): void {
  const icoIndexValue = storage.getPrimitive<u32>("icoIndex", 0) + 1;
  storage.set<u32>("icoIndex", icoIndexValue);
}

function _getICOindex(): u32 {
  return storage.getPrimitive<u32>("icoIndex", 0);
}

function _getTimeAsSeconds(): u64 {
  return Context.blockTimestamp / 10 ** 9;
}

function _getTokenAmount(_usdtAmount: u32, _absoluteUsdtPrice: u32): u32 {
  var absoluteUsdtAmount = _usdtAmount * 10 ** 6;
  return absoluteUsdtAmount / _absoluteUsdtPrice;
}

function _preValidatePurchase(
  _beneficiary: string,
  _tokenAmount: u32,
  _usdtAmount: u32,
  _icoType: u32
): void {
  assert(_tokenAmount > 0, "ERROR at _preValidatePurchase: Token amount is 0.");

  var ICOData = ICODatas.getSome(_icoType);
  if (!ICOData.IsFree) {
    //beneficiary nin yeterli usdtsi var mı ?
  }

  assert(
    ICOData.ICOtokenAllocated + _tokenAmount <= ICOData.ICOsupply,
    "ERROR at _preValidatePurchase: Not enough token in the ICO supply"
  );
}

function _updatePurchasingState(
  _usdtAmount: u32,
  _tokenAmount: u32,
  _icoType: u32
): void {
  var ICOData = ICODatas.getSome(_icoType);
  ICOData.ICOtokenAllocated += _tokenAmount;
  ICOData.ICOusdtRaised += _usdtAmount;
  ICODatas.set(_icoType, ICOData);
}

function _forwardFunds(usdtAmount: u32): void {
  //usdt.transferFrom(msg.sender, usdtWallet, usdtAmount);
  //contract promise to usdt contract
}
function _onlyOwner(funcName: string): void {
  assert(
    Context.predecessor == Context.contractName,
    funcName + "method is private. Only owner call this function."
  );
}

function _onlyVestingContract(funcName: string): void {
  const vestingContractAddress: string = storage.getPrimitive<string>(
    "vesting-address",
    ""
  );
  assert(
    Context.predecessor == vestingContractAddress,
    funcName + "method is private. Only vesting contract call this function."
  );
}
function addAddressToWhitelist(_beneficiary: string, _icoType: u32): void {
  assert(
    !isWhitelisted(_beneficiary, _icoType),
    "ERROR at addAddressToWhitelist: Already whitelisted."
  );

  var tempWhitelistArray = whitelist.getSome(_icoType);
  tempWhitelistArray.push(_beneficiary);
  whitelist.set(_icoType, tempWhitelistArray);
}

function isWhitelisted(_beneficiary: string, _icoType: u32): bool {
  var tempWhitelistArray = whitelist.getSome(_icoType);
  return tempWhitelistArray.includes(_beneficiary);
}

//////////////////////////////////////////////////////////////////////////////////////////

//updateVestingSchedulecall token satın alım artırımı yapmak isteyenler için scheduleu günceller
//////////////////////////////////////////////////////////////////////////////////////////

@nearBindgen
class updateVestingScheduleCallArgs {
  constructor(
    public _vestingKeyString: string,
    public _tokenAmount: u32,
    public _totalVestingAllocation: u32,
    public _usdtAmount: u32
  ) {}
}

//updating specific vestingschedule struct
function updateVestingScheduleCall(
  _vestingKeyString: string,
  _tokenAmount: u32,
  _totalVestingAllocation: u32,
  _usdtAmount: u32
): void {
  assert(
    Context.prepaidGas >= 20 * TGAS,
    "ERROR at updateVestingScheduleCall: Please attach at least 20 Tgas"
  );
  const vestingContractAddress: string = storage.getPrimitive<string>(
    "vesting-address",
    ""
  );
  const args: updateVestingScheduleCallArgs = new updateVestingScheduleCallArgs(
    _vestingKeyString,
    _tokenAmount,
    _totalVestingAllocation,
    _usdtAmount
  );

  const promise: ContractPromise = ContractPromise.create(
    vestingContractAddress,
    "updateVestingSchedule",
    args,
    5 * TGAS,
    NO_DEPOSIT
  );
  const callbackPromise = promise.then(
    Context.contractName, // this contract’s account id
    "updateVestingScheduleCallCallback", // the method to call after the previous cross contract call finishes
    "{}",
    5 * TGAS, // gas to attach to the callback
    NO_DEPOSIT // yocto NEAR to attach to the callback
  );

  callbackPromise.returnAsResult(); // return the result of updateVestingScheduleCallCallback
}

export function updateVestingScheduleCallCallback(): bool {
  _onlyOwner("updateVestingScheduleCallCallback");

  const results = ContractPromise.getResults();
  assert(
    results.length == 1,
    "ERROR at updateVestingScheduleCallCallback: This is a callback method"
  );
  const response = results[0];

  if (response.status == XCC_SUCCESS) {
    logging.log("basarili updateVestingScheduleCall");
  } else {
    logging.log("basarisiz updateVestingScheduleCall");
  }
  return response.status ? true : false;
}

//////////////////////////////////////////////////////////////////////////////////////////

//createVestingScheduleCall verilen özelliklerde vestingschedule oluşturur
////////////////////////////////////////////////////////////////////////////////////
@nearBindgen
class createVestingScheduleCallArgs {
  constructor(
    public _beneficiaryAddress: string,
    public _icoType: u32,
    public _allocation: u32,
    public _numberOfCliffMonths: u32,
    public _numberOfVestingMonths: u32,
    public _unlockRate: u32,
    public _isRevocable: boolean,
    public _investedUsdt: u32,
    public _icoStartDate: u64,
    public _tokenAbsoluteUsdtPrice: u32
  ) {}
}

function createVestingScheduleCall(
  _beneficiaryAddress: string,
  _icoType: u32,
  _allocation: u32,
  _numberOfCliffMonths: u32,
  _numberOfVestingMonths: u32,
  _unlockRate: u32,
  _isRevocable: boolean,
  _investedUsdt: u32,
  _icoStartDate: u64,
  _tokenAbsoluteUsdtPrice: u32
): void {
  assert(
    Context.prepaidGas >= 20 * TGAS,
    "ERROR at createVestingScheduleCall: Please attach at least 20 Tgas"
  );
  const vestingContractAddress: string = storage.getPrimitive<string>(
    "vesting-address",
    ""
  );
  const args: createVestingScheduleCallArgs = new createVestingScheduleCallArgs(
    _beneficiaryAddress,
    _icoType,
    _allocation,
    _numberOfCliffMonths,
    _numberOfVestingMonths,
    _unlockRate,
    _isRevocable,
    _investedUsdt,
    _icoStartDate,
    _tokenAbsoluteUsdtPrice
  );
  const promise: ContractPromise = ContractPromise.create(
    vestingContractAddress,
    "createVestingSchedule",
    args,
    5 * TGAS,
    NO_DEPOSIT
  );
  // Create a promise to callback, needs 5 Tgas
  const callbackPromise = promise.then(
    Context.contractName,
    "createVestingScheduleCallCallback",
    "{}",
    5 * TGAS,
    NO_DEPOSIT
  );

  callbackPromise.returnAsResult();
}

export function createVestingScheduleCallCallback(): bool {
  _onlyOwner("createVestingScheduleCallCallback");

  const results = ContractPromise.getResults();
  assert(
    results.length == 1,
    "ERROR at createVestingScheduleCallCallback: This is a callback method"
  );

  const response = results[0];

  if (response.status == XCC_SUCCESS) {
    // `set_greeting` succeeded
    return true;
  } else {
    // it failed
    return false;
  }
}
////////////////////////////////////////////////////////////////////////////////////

//////////////////////////////////////////////////////////////////////////////////////////

//changeIcoStateInVestingCall vesting contractında ico roundlarının stateini değiştirir
//////////////////////////////////////////////////////////////////////////////////////////

@nearBindgen
class changeIcoStateInVestingCallArgs {
  constructor(public _icoType: u32, public _icoState: u32) {}
}

//changing specific ICO type state
function changeIcoStateInVestingCall(_icoType: u32, _icoState: u32): void {
  assert(
    Context.prepaidGas >= 20 * TGAS,
    "ERROR at changeIcoStateInVestingCall: Please attach at least 20 Tgas"
  );
  const vestingContractAddress: string = storage.getPrimitive<string>(
    "vesting-address",
    ""
  );
  const args: changeIcoStateInVestingCallArgs =
    new changeIcoStateInVestingCallArgs(_icoType, _icoState);

  const promise: ContractPromise = ContractPromise.create(
    vestingContractAddress,
    "changeICOstate",
    args,
    5 * TGAS,
    NO_DEPOSIT
  );
  const callbackPromise = promise.then(
    Context.contractName, // this contract’s account id
    "changeIcoStateInVestingCallCallback", // the method to call after the previous cross contract call finishes
    "{}",
    5 * TGAS, // gas to attach to the callback
    NO_DEPOSIT // yocto NEAR to attach to the callback
  );

  callbackPromise.returnAsResult(); // return the result of changeIcoStateInVestingCallCallback
}

export function changeIcoStateInVestingCallCallback(): bool {
  _onlyOwner("changeIcoStateInVestingCallCallback");

  const results = ContractPromise.getResults();
  assert(
    results.length == 1,
    "ERROR at changeIcoStateInVestingCallCallback: This is a callback method"
  );
  const response = results[0];

  if (response.status == XCC_SUCCESS) {
    logging.log("basarili changeIcoStateInVestingCall");
  } else {
    logging.log("basarisiz changeIcoStateInVestingCall");
  }
  return response.status ? true : false;
}
