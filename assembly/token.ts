import { Context, storage, logging, PersistentMap, u128 } from "near-sdk-as";

const balances = new PersistentMap<string, u128>("b:");
const approves = new PersistentMap<string, u128>("a:");

export function ft_init(
  tokenName: string,
  tokenSymbol: string,
  tokenPrecision: u8,
  totalTokenSupply: u128
): string {
  var contractOwner = Context.sender;

  logging.log("initialOwner: " + contractOwner);
  assert(
    storage.get<string>("init") == null,
    "Already initialized token supply"
  );
  storage.set("init", "initialized");

  storage.set("totalTokenSupply", totalTokenSupply);

  //set Owner Account
  storage.set<string>("owner", contractOwner);

  //set Token Name
  storage.set<string>("tokenName", tokenName);

  //set Token Symbol
  storage.set<string>("tokenSymbol", tokenSymbol);

  //set Precision
  storage.set<u8>("tokenPrecision", tokenPrecision);

  // set total initial supply to owner’s balance
  balances.set(contractOwner, totalTokenSupply);

  return storage.getPrimitive("init", "not initialized");
}

/**
 * view function ** returns total supply of tokens
 */
export function ft_getTotalSupply(): string {
  return storage.getSome<u128>("totalTokenSupply").toString();
}

/**
 * view function ** get address of the contract owner
 */
export function ft_getOwner(): string {
  return storage.getSome<string>("owner");
}

/**
 * view function ** get name of the token
 */
export function ft_getTokenName(): string {
  return storage.getSome<string>("tokenName");
}

/**
 * view function ** get token symbol
 */
export function ft_getTokenSymbol(): string {
  return storage.getSome<string>("tokenSymbol");
}

/**
 * view function ** returns number of decimals the token uses. e.g. 8 means to divide the token
 * amount by 100000000 to get its user representation
 */
export function ft_getPrecision(): u8 {
  return storage.getSome<u8>("tokenPrecision");
}

/**
 * view function ** returns the balance of giving account
 */
export function ft_balanceOf(tokenOwner: string): u128 {
  logging.log("balanceOf: " + tokenOwner);
  if (!balances.contains(tokenOwner)) {
    return u128.Zero;
  }
  const result = balances.getSome(tokenOwner);
  return result;
}

/**
 * utility function ** returns the balance of giving account
 */
function ft_getBalance(owner: string): u128 {
  return balances.contains(owner) ? balances.getSome(owner) : u128.Zero;
}

//view function ** returns approve amount by giving tokenOwner and spender account id
export function ft_getAllowance(tokenOwner: string, spender: string): u128 {
  const key = tokenOwner + ":" + spender;
  if (!approves.contains(key)) {
    return u128.Zero;
  }
  return approves.getSome(key);
}

/**
 * call function ** transfers tokens Context.sender to the "to"
 */
export function ft_transfer(to: string, tokens: u128): boolean {
  assert(tokens > u128.Zero, "Please enter valid amount.");

  const fromAmount = ft_getBalance(Context.sender);
  assert(fromAmount >= tokens, "not enough tokens on account");

  balances.set(Context.sender, u128.sub(fromAmount, tokens));
  balances.set(to, u128.add(ft_getBalance(to), tokens));

  logging.log(
    "transfer from: " +
      Context.sender +
      " to: " +
      to +
      " tokens: " +
      tokens.toString()
  );
  return true;
}

/**
 * call function ** specify allowance of given account(spender)
 */
export function ft_approve(spender: string, tokens: u128): boolean {
  assert(tokens > u128.Zero, "Please enter valid amount.");
  const tokenOwner = Context.sender;
  assert(tokenOwner != spender, "Can not increment allowance for yourself.");

  approves.set(Context.sender + ":" + spender, tokens);
  logging.log("approve: " + spender + " tokens: " + tokens.toString());
  return true;
}

/**
 * call function ** transfers tokens "from" to the "to" according to the approves mapping
 */
export function ft_transferFrom(
  from: string,
  to: string,
  tokens: u128
): boolean {
  assert(tokens > u128.Zero, "Please enter valid amount.");

  const fromAmount = ft_getBalance(from);
  assert(fromAmount >= tokens, "not enough tokens on account");

  const approvedAmount = ft_getAllowance(from, to);
  assert(tokens <= approvedAmount, "not enough tokens approved to transfer");

  approves.set(from + ":" + to, u128.sub(approvedAmount, tokens));

  balances.set(from, u128.sub(fromAmount, tokens));
  balances.set(to, u128.add(ft_getBalance(to), tokens));

  logging.log(
    "Transferring from : " +
      from +
      " to: " +
      to +
      " tokens: " +
      tokens.toString()
  );
  return true;
}
