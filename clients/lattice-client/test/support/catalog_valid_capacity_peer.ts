import {readFileSync} from "node:fs";
import {produce,check} from "./catalog_valid_capacity_fixture";
const consume=process.argv[2]==="consume",bundle=consume?JSON.parse(readFileSync(process.argv[3]!,"utf8")):await produce();
await check(bundle);console.log(JSON.stringify(consume?{checked:true}:bundle));
